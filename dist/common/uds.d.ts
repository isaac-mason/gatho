import type { Socket } from 'node:net';
import * as pack from 'packcat';
declare const ProcessMetrics: {
    type: "object";
    fields: {
        memoryRss: {
            type: "float64";
        };
        memoryHeapUsed: {
            type: "float64";
        };
        memoryHeapTotal: {
            type: "float64";
        };
        cpuUser: {
            type: "float64";
        };
        cpuSystem: {
            type: "float64";
        };
    };
};
declare const Ready: {
    type: "object";
    fields: {
        type: {
            type: "literal";
            value: "ready";
        };
        port: {
            type: "uint16";
        };
    };
};
declare const Heartbeat: {
    type: "object";
    fields: {
        type: {
            type: "literal";
            value: "heartbeat";
        };
        timestamp: {
            type: "float64";
        };
        metrics: {
            type: "object";
            fields: {
                memoryRss: {
                    type: "float64";
                };
                memoryHeapUsed: {
                    type: "float64";
                };
                memoryHeapTotal: {
                    type: "float64";
                };
                cpuUser: {
                    type: "float64";
                };
                cpuSystem: {
                    type: "float64";
                };
            };
        };
        clientIds: {
            type: "list";
            of: {
                type: "string";
            };
        };
    };
};
declare const ClientConnected: {
    type: "object";
    fields: {
        type: {
            type: "literal";
            value: "client-connected";
        };
        clientId: {
            type: "string";
        };
    };
};
declare const ClientDisconnected: {
    type: "object";
    fields: {
        type: {
            type: "literal";
            value: "client-disconnected";
        };
        clientId: {
            type: "string";
        };
    };
};
declare const ErrorMsg: {
    type: "object";
    fields: {
        type: {
            type: "literal";
            value: "error";
        };
        message: {
            type: "string";
        };
    };
};
declare const Stopped: {
    type: "object";
    fields: {
        type: {
            type: "literal";
            value: "stopped";
        };
    };
};
declare const RoomMessageSchema: {
    type: "union";
    key: "type";
    variants: [{
        type: "object";
        fields: {
            type: {
                type: "literal";
                value: "ready";
            };
            port: {
                type: "uint16";
            };
        };
    }, {
        type: "object";
        fields: {
            type: {
                type: "literal";
                value: "heartbeat";
            };
            timestamp: {
                type: "float64";
            };
            metrics: {
                type: "object";
                fields: {
                    memoryRss: {
                        type: "float64";
                    };
                    memoryHeapUsed: {
                        type: "float64";
                    };
                    memoryHeapTotal: {
                        type: "float64";
                    };
                    cpuUser: {
                        type: "float64";
                    };
                    cpuSystem: {
                        type: "float64";
                    };
                };
            };
            clientIds: {
                type: "list";
                of: {
                    type: "string";
                };
            };
        };
    }, {
        type: "object";
        fields: {
            type: {
                type: "literal";
                value: "client-connected";
            };
            clientId: {
                type: "string";
            };
        };
    }, {
        type: "object";
        fields: {
            type: {
                type: "literal";
                value: "client-disconnected";
            };
            clientId: {
                type: "string";
            };
        };
    }, {
        type: "object";
        fields: {
            type: {
                type: "literal";
                value: "error";
            };
            message: {
                type: "string";
            };
        };
    }, {
        type: "object";
        fields: {
            type: {
                type: "literal";
                value: "stopped";
            };
        };
    }];
};
export declare const ipcCodec: {
    pack: (value: {
        type: "ready";
        port: number;
    } | {
        type: "heartbeat";
        timestamp: number;
        metrics: {
            memoryRss: number;
            memoryHeapUsed: number;
            memoryHeapTotal: number;
            cpuUser: number;
            cpuSystem: number;
        };
        clientIds: string[];
    } | {
        type: "client-connected";
        clientId: string;
    } | {
        type: "client-disconnected";
        clientId: string;
    } | {
        type: "error";
        message: string;
    } | {
        type: "stopped";
    }) => Uint8Array;
    packInto: (value: {
        type: "ready";
        port: number;
    } | {
        type: "heartbeat";
        timestamp: number;
        metrics: {
            memoryRss: number;
            memoryHeapUsed: number;
            memoryHeapTotal: number;
            cpuUser: number;
            cpuSystem: number;
        };
        clientIds: string[];
    } | {
        type: "client-connected";
        clientId: string;
    } | {
        type: "client-disconnected";
        clientId: string;
    } | {
        type: "error";
        message: string;
    } | {
        type: "stopped";
    }, u8: Uint8Array, offset: number) => pack.PackIntoResult;
    unpack: (u8: Uint8Array) => {
        type: "ready";
        port: number;
    } | {
        type: "heartbeat";
        timestamp: number;
        metrics: {
            memoryRss: number;
            memoryHeapUsed: number;
            memoryHeapTotal: number;
            cpuUser: number;
            cpuSystem: number;
        };
        clientIds: string[];
    } | {
        type: "client-connected";
        clientId: string;
    } | {
        type: "client-disconnected";
        clientId: string;
    } | {
        type: "error";
        message: string;
    } | {
        type: "stopped";
    };
    validate: (value: {
        type: "ready";
        port: number;
    } | {
        type: "heartbeat";
        timestamp: number;
        metrics: {
            memoryRss: number;
            memoryHeapUsed: number;
            memoryHeapTotal: number;
            cpuUser: number;
            cpuSystem: number;
        };
        clientIds: string[];
    } | {
        type: "client-connected";
        clientId: string;
    } | {
        type: "client-disconnected";
        clientId: string;
    } | {
        type: "error";
        message: string;
    } | {
        type: "stopped";
    }) => boolean;
    source: {
        pack: string;
        unpack: string;
        validate: string;
        packInto: string;
    };
};
export type RoomMessage = pack.SchemaType<typeof RoomMessageSchema>;
export type ReadyMessage = pack.SchemaType<typeof Ready>;
export type HeartbeatMessage = pack.SchemaType<typeof Heartbeat>;
export type ProcessMetricsMessage = pack.SchemaType<typeof ProcessMetrics>;
export type ClientConnectedMessage = pack.SchemaType<typeof ClientConnected>;
export type ClientDisconnectedMessage = pack.SchemaType<typeof ClientDisconnected>;
export type ErrorMessage = pack.SchemaType<typeof ErrorMsg>;
export type StoppedMessage = pack.SchemaType<typeof Stopped>;
export type UdsConnection = {
    send: (msg: RoomMessage) => void;
    close: () => void;
};
export declare function sendMessage(socket: Socket, msg: RoomMessage): void;
export declare function createFrameReader(onMessage: (msg: RoomMessage) => void, onError?: (err: unknown) => void): (data: Buffer | Uint8Array) => void;
export {};
