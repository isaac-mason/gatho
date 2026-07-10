export { type MemoryDriverOptions, createMemoryDriver } from './memory';
// note: the redis driver lives at the `gatho/driver/redis` subpath, not here.
// ioredis is an optional peer dep; keeping the redis import out of `gatho/driver`
// lets memory-only / bundled (workerd host) installs pull this module without
// ioredis present. import { createRedisDriver } from 'gatho/driver/redis'.
export type {
    ClientInfo,
    ClientReservation,
    ClientStatus,
    DesiredRoom,
    Driver,
    ListRoomsFilter,
    ListServersFilter,
    HeartbeatOptions,
    RoomData,
    RoomInfo,
    RoomStatus,
    ServerInfo,
    TagFilter,
} from './types';
export {
    DriverConfigError,
    GathoError,
    InvalidTagError,
    PayloadTooLargeError,
    RoomFailedError,
    RoomNotFoundError,
    RoomNotRunningError,
    RoomStartError,
    RoomTimeoutError,
    ServerNotFoundError,
} from './errors';
export { RESERVE_DATA_MAX_BYTES, RESERVE_TAGS_MAX_BYTES } from './types';
// the redis driver lives in a separate bundle (gatho/driver/redis) and imports
// these validators from `gatho/driver` rather than relatively, so it reuses ONE
// copy of the error classes they throw (PayloadTooLargeError, InvalidTagError) —
// otherwise a separately-bundled copy would break `instanceof` across the split.
export { validateTags, validateReserveData, validateReserveTagsSize } from './types';
