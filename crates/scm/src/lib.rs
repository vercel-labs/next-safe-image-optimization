//! Sending file descriptors over Unix sockets (`SCM_RIGHTS`), for the fork server
//! (`crates/worker/src/fork_server.rs`) and the shim's side of it (`crates/shim/src/fork.rs`).

#![cfg(unix)]

use std::io;
use std::mem;
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd, RawFd};

/// The most file descriptors a message can carry.
pub const MAX_FDS: usize = 3;

/// Room for `MAX_FDS` file descriptors (`CMSG_SPACE`), aligned for `cmsghdr`.
type Space = [u64; 8];

/// Sends `data` in one message, with `fds` attached to it.
pub fn send(socket: BorrowedFd, data: &[u8], fds: &[BorrowedFd]) -> io::Result<()> {
    let mut iov = libc::iovec {
        iov_base: data.as_ptr().cast_mut().cast(),
        iov_len: data.len(),
    };
    let mut space: Space = [0; 8];
    let mut header: libc::msghdr = unsafe { mem::zeroed() };
    header.msg_iov = &mut iov;
    header.msg_iovlen = 1;
    if !fds.is_empty() {
        if fds.len() > MAX_FDS {
            return Err(io::Error::other("too many file descriptors"));
        }
        let len = mem::size_of_val(fds) as libc::c_uint;
        header.msg_control = space.as_mut_ptr().cast();
        header.msg_controllen = unsafe { libc::CMSG_SPACE(len) } as _;
        unsafe {
            let cmsg = libc::CMSG_FIRSTHDR(&header);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN(len) as _;
            let data = libc::CMSG_DATA(cmsg).cast::<RawFd>();
            for (i, fd) in fds.iter().enumerate() {
                data.add(i).write_unaligned(fd.as_raw_fd());
            }
        }
    }
    loop {
        let sent = unsafe { libc::sendmsg(socket.as_raw_fd(), &header, 0) };
        if sent >= 0 && sent as usize == data.len() {
            return Ok(());
        }
        let err = io::Error::last_os_error();
        if sent >= 0 {
            // On a stream socket, the rest would arrive without the file descriptors.
            return Err(io::Error::other("the message was only partially sent"));
        }
        if err.kind() != io::ErrorKind::Interrupted {
            return Err(err);
        }
    }
}

/// Fills `buf`, and returns the file descriptors that came with it (close-on-exec). A stream
/// socket can split a message, but they arrive with its first byte.
pub fn receive(socket: BorrowedFd, buf: &mut [u8]) -> io::Result<Vec<OwnedFd>> {
    let mut fds = Vec::new();
    let mut filled = 0;
    while filled < buf.len() {
        let rest = &mut buf[filled..];
        let mut iov = libc::iovec {
            iov_base: rest.as_mut_ptr().cast(),
            iov_len: rest.len(),
        };
        let mut space: Space = [0; 8];
        let mut header: libc::msghdr = unsafe { mem::zeroed() };
        header.msg_iov = &mut iov;
        header.msg_iovlen = 1;
        header.msg_control = space.as_mut_ptr().cast();
        header.msg_controllen = mem::size_of_val(&space) as _;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        let flags = libc::MSG_CMSG_CLOEXEC;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        let flags = 0;
        let read = unsafe { libc::recvmsg(socket.as_raw_fd(), &mut header, flags) };
        if read < 0 {
            let err = io::Error::last_os_error();
            if err.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(err);
        }
        // Takes ownership first, so that they're closed even if this fails.
        unsafe {
            let mut cmsg = libc::CMSG_FIRSTHDR(&header);
            while !cmsg.is_null() {
                if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                    let data = libc::CMSG_DATA(cmsg).cast::<RawFd>();
                    let len = (*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize;
                    for i in 0..len / mem::size_of::<RawFd>() {
                        let fd = OwnedFd::from_raw_fd(data.add(i).read_unaligned());
                        #[cfg(not(any(target_os = "linux", target_os = "android")))]
                        libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
                        fds.push(fd);
                    }
                }
                cmsg = libc::CMSG_NXTHDR(&header, cmsg);
            }
        }
        if header.msg_flags & libc::MSG_CTRUNC != 0 {
            return Err(io::Error::other("too many file descriptors"));
        }
        if read == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        filled += read as usize;
    }
    Ok(fds)
}
