import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { roomSocketPath } from '../../src/server/server';

describe('roomSocketPath', () => {
    it('nests each room socket under its own per-room subdirectory', () => {
        expect(roomSocketPath('/tmp/gatho-ipc', 'room-1')).toBe('/tmp/gatho-ipc/room-1/sock');
    });

    it('gives sibling rooms distinct, isolatable directories', () => {
        const a = roomSocketPath('/tmp/gatho-ipc', 'room-a');
        const b = roomSocketPath('/tmp/gatho-ipc', 'room-b');
        // dirname is the per-room mount unit — they must differ so one room's
        // mount can't expose the other's socket.
        expect(dirname(a)).not.toBe(dirname(b));
    });

    it('stays within the unix socket path limit for a long tmpdir + uuid roomId', () => {
        // unix socket paths have a hard ~104-byte limit on macOS (sun_path). The
        // default socketDir is tmpdir()/gatho-ipc, and macOS tmpdir is ~49 chars,
        // so the per-room subdir + filename must not blow the budget a uuid leaves.
        const macosTmpSocketDir = '/var/folders/ly/r1gl91nj5xn54032_47_ksjr0000gn/T/gatho-ipc';
        const uuid = '760d9c89-eaf6-48bf-bb26-c652b930baa1';
        expect(roomSocketPath(macosTmpSocketDir, uuid).length).toBeLessThanOrEqual(103);
    });

    it.each(['../escape', 'a/b', 'a\\b', '..', '.'])(
        'rejects roomId %j that could escape socketDir',
        (roomId) => {
            expect(() => roomSocketPath('/tmp/gatho-ipc', roomId)).toThrow(/invalid roomId/);
        },
    );
});
