# CHANGELOG

## v0.0.1 (Unreleased)

- Initial release!
- **server:** per-room UDS sockets now live at `socketDir/<roomId>/sock` instead of the
  flat `socketDir/<roomId>.sock`. This lets a container runner mount each room only its
  own socket directory, isolating the (unauthenticated) server↔room IPC channel from
  sibling containers — important when rooms run untrusted code. `SpawnContext` gains a
  `socketDir` field giving the room's own socket directory, so a runner just mounts
  `ctx.socketDir` into the room. Rooms are unaffected (they read `GATHO_SOCKET`). The
  socket filename is `sock` (not `room.sock`) so the new path is the same length as the
  old flat one — unix socket paths have a hard ~104-byte limit (macOS) that the long
  default `tmpdir()` already pushes against. **Breaking** only for custom runners that
  hardcode the old flat `<roomId>.sock` path instead of using `ctx.socket` /
  `GATHO_SOCKET`.
