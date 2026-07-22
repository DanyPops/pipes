# @danypops/pipes-daemon

Scaffold only. This will become the supervised daemon that owns CI
credentials, backend adapters (GitHub/GitLab/Jenkins/Prow), and a local
SQLite pool of run history, built on `@danypops/daemon-kit`.

Currently exposes a single `health` operation to prove the daemon-kit
composition (paths, storage, http, daemon, rpc-client) works end to end
before any real CI backend is wired in.
