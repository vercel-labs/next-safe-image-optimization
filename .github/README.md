# CI caching

We don't use GitHub Actions caches. This project is small and CI is fast enough
without caches, so the time saved isn't worth the risk of cache poisoning.
Restoring dependencies or build outputs from a poisoned cache could compromise
release artifacts.

In the future, we only skip caches during releases, but the complexity is not
currently worth it.
