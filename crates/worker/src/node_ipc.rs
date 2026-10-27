//! The child's side of Node's IPC channel (`stdio: [..., 'ipc']` in `child_process.spawn`), which
//! can pass file descriptors to the parent.
//!
//! Node doesn't support using its IPC channel with a process that isn't Node, but the protocol
//! hasn't changed significantly since Node 0.8 (2012), and Bun and Deno use the same one (tested
//! with Bun 1.4.4 and Deno 2.9.8). We use (see Node's `lib/internal/child_process.js`):
//!
//! - Messages are lines of JSON, in both directions: `child.send()` writes one, and Node emits each
//!   line we write as a `'message'` event.
//! - To send a socket, the line is `{"cmd":"NODE_HANDLE","type":"net.Socket","msg":<message>}`, with
//!   the file descriptor attached (`SCM_RIGHTS`) to the same `sendmsg`. Node emits `'message'` with
//!   `msg` and a `net.Socket`.
//! - Node replies to each with `{"cmd":"NODE_HANDLE_ACK"}` (since 0.12), or
//!   `{"cmd":"NODE_HANDLE_NACK"}` if the file descriptor didn't arrive (since 2017). Some macOS
//!   versions close a file descriptor in flight if the sender closes its copy first, so like Node,
//!   we keep ours until the reply.
//! - Messages with a `cmd` starting with `NODE_` are Node's own. We ignore the others.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{self, Write};
use std::mem::{self, ManuallyDrop};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::ptr;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

pub enum Event<M, T> {
    Message(M),
    /// Node didn't receive the socket sent with this tag (`NODE_HANDLE_NACK`), or the message it
    /// was sent with.
    Lost(T),
}

pub enum Error {
    /// The parent closed the channel.
    Closed,
    /// A message that isn't JSON, or not the expected type.
    Invalid,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Line<M> {
    /// Node's own messages.
    Internal {
        cmd: String,
    },
    Message(M),
}

/// Node's wrapper for a message with a socket attached.
#[derive(Serialize)]
struct Handle<'a, M> {
    cmd: &'static str,
    #[serde(rename = "type")]
    kind: &'static str,
    msg: &'a M,
}

/// The channel to the parent. Writes block. `T` tags each socket sent, so that `Event::Lost` can
/// say which one didn't arrive.
pub struct Channel<T> {
    fd: OwnedFd,
    /// Received, after the last complete message.
    buffer: Vec<u8>,
    /// Sockets sent that the parent hasn't replied to yet, oldest first.
    sent: VecDeque<(T, OwnedFd)>,
}

impl<T> Channel<T> {
    /// Fails if `fd` isn't open.
    ///
    /// # Safety
    ///
    /// Takes ownership of `fd`, which nothing else may own.
    pub unsafe fn open(fd: RawFd) -> io::Result<Self> {
        // In case the runtime left it non-blocking.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags & !libc::O_NONBLOCK) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            fd: unsafe { OwnedFd::from_raw_fd(fd) },
            buffer: Vec::new(),
            sent: VecDeque::new(),
        })
    }

    /// Reads once (blocking, unless the channel is readable), and returns the events from the
    /// complete messages.
    pub fn receive<M: DeserializeOwned>(&mut self) -> Result<Vec<Event<M, T>>, Error> {
        let mut chunk = [0u8; 4096];
        let read =
            unsafe { libc::read(self.fd.as_raw_fd(), chunk.as_mut_ptr().cast(), chunk.len()) };
        if read <= 0 {
            return Err(Error::Closed);
        }
        self.buffer.extend_from_slice(&chunk[..read as usize]);
        let end = self
            .buffer
            .iter()
            .rposition(|&b| b == b'\n')
            .map_or(0, |i| i + 1);
        let complete: Vec<u8> = self.buffer.drain(..end).collect();
        let mut events = Vec::new();
        for line in complete
            .split(|&b| b == b'\n')
            .filter(|line| !line.is_empty())
        {
            match serde_json::from_slice(line).map_err(|_| Error::Invalid)? {
                Line::Internal { cmd } if cmd == "NODE_HANDLE_ACK" => {
                    self.sent.pop_front();
                }
                Line::Internal { cmd } if cmd == "NODE_HANDLE_NACK" => {
                    if let Some((tag, _)) = self.sent.pop_front() {
                        events.push(Event::Lost(tag));
                    }
                }
                Line::Internal { .. } => {}
                Line::Message(message) => events.push(Event::Message(message)),
            }
        }
        Ok(events)
    }

    pub fn send(&self, message: &impl Serialize) -> io::Result<()> {
        self.write(&line(message), None)
    }

    /// Sends a stream socket (like one end of a socketpair), which the parent receives as a
    /// `net.Socket`, with `message`.
    pub fn send_socket(
        &mut self,
        message: &impl Serialize,
        socket: OwnedFd,
        tag: T,
    ) -> io::Result<()> {
        let handle = Handle {
            cmd: "NODE_HANDLE",
            kind: "net.Socket",
            msg: message,
        };
        self.write(&line(&handle), Some(socket.as_raw_fd()))?;
        self.sent.push_back((tag, socket));
        Ok(())
    }

    fn write(&self, line: &[u8], attached: Option<RawFd>) -> io::Result<()> {
        let fd = self.fd.as_raw_fd();
        let sent = match attached {
            Some(attached) => send_with_fd(fd, line, attached)?,
            None => 0,
        };
        ManuallyDrop::new(unsafe { File::from_raw_fd(fd) }).write_all(&line[sent..])
    }
}

impl<T> AsRawFd for Channel<T> {
    fn as_raw_fd(&self) -> RawFd {
        self.fd.as_raw_fd()
    }
}

fn line(message: &impl Serialize) -> Vec<u8> {
    let mut line = serde_json::to_vec(message).expect("messages serialize");
    line.push(b'\n');
    line
}

/// Sends the start of `data` (returning how much), with `attached` as `SCM_RIGHTS`.
fn send_with_fd(socket: RawFd, data: &[u8], attached: RawFd) -> io::Result<usize> {
    let mut iov = libc::iovec {
        iov_base: data.as_ptr() as *mut libc::c_void,
        iov_len: data.len(),
    };
    // Aligned for `cmsghdr`, and larger than one header with one fd.
    let mut control = [0u64; 4];
    let space = unsafe { libc::CMSG_SPACE(mem::size_of::<RawFd>() as u32) } as usize;
    assert!(space <= mem::size_of_val(&control));
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = control.as_mut_ptr().cast();
    message.msg_controllen = space as _;
    unsafe {
        let header = libc::CMSG_FIRSTHDR(&message);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(mem::size_of::<RawFd>() as u32) as _;
        ptr::write_unaligned(libc::CMSG_DATA(header).cast::<RawFd>(), attached);
    }
    let sent = unsafe { libc::sendmsg(socket, &message, 0) };
    if sent < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(sent as usize)
}
