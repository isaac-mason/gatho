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
            type: "optional";
            of: {
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
        };
        clients: {
            type: "list";
            of: {
                type: "object";
                fields: {
                    clientId: {
                        type: "string";
                    };
                    tags: {
                        type: "record";
                        field: {
                            type: "string";
                        };
                    };
                };
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
        roomId: {
            type: "string";
        };
        tags: {
            type: "record";
            field: {
                type: "string";
            };
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
declare const NotifyMessageSchema: {
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
                type: "optional";
                of: {
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
            };
            clients: {
                type: "list";
                of: {
                    type: "object";
                    fields: {
                        clientId: {
                            type: "string";
                        };
                        tags: {
                            type: "record";
                            field: {
                                type: "string";
                            };
                        };
                    };
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
            roomId: {
                type: "string";
            };
            tags: {
                type: "record";
                field: {
                    type: "string";
                };
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
export declare const notifyCodec: {
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
        } | undefined;
        clients: {
            clientId: string;
            tags: Record<string, string>;
        }[];
    } | {
        type: "client-connected";
        clientId: string;
        roomId: string;
        tags: Record<string, string>;
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
        } | undefined;
        clients: {
            clientId: string;
            tags: Record<string, string>;
        }[];
    } | {
        type: "client-connected";
        clientId: string;
        roomId: string;
        tags: Record<string, string>;
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
        } | undefined;
        clients: {
            clientId: string;
            tags: Record<string, string>;
        }[];
    } | {
        type: "client-connected";
        clientId: string;
        roomId: string;
        tags: Record<string, string>;
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
        } | undefined;
        clients: {
            clientId: string;
            tags: Record<string, string>;
        }[];
    } | {
        type: "client-connected";
        clientId: string;
        roomId: string;
        tags: Record<string, string>;
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
export type NotifyMessage = pack.SchemaType<typeof NotifyMessageSchema>;
export type ReadyMessage = pack.SchemaType<typeof Ready>;
export type HeartbeatMessage = pack.SchemaType<typeof Heartbeat>;
export type ProcessMetricsMessage = pack.SchemaType<typeof ProcessMetrics>;
export type ClientConnectedMessage = pack.SchemaType<typeof ClientConnected>;
export type ClientDisconnectedMessage = pack.SchemaType<typeof ClientDisconnected>;
export type ErrorMessage = pack.SchemaType<typeof ErrorMsg>;
export type StoppedMessage = pack.SchemaType<typeof Stopped>;
/** the room's handle for notifying its managing server — connected over
 *  uds/tcp, or wired straight to the server's message handler when hosted
 *  in-process (`notify.direct`). */
export type Notifier = {
    send: (msg: NotifyMessage) => void;
    close: () => void;
};
/** wrap raw payload bytes in a length-prefixed frame */
export declare function encodeRawFrame(payload: Uint8Array): Uint8Array;
/** encode a notify message as a length-prefixed frame, ready to write to any pipe */
export declare function encodeNotifyFrame(msg: NotifyMessage): Uint8Array;
/** streaming frame parser — handles partial reads and buffering across chunks.
 *  returns a push function that accepts raw chunks and invokes `onFrame` with
 *  each complete payload (header stripped). */
export declare function createFrameParser(onFrame: (payload: Uint8Array) => void): (data: Uint8Array) => void;
/** streaming notify-message reader built on the frame parser.
 *  malformed frames are dropped via `onError` rather than thrown — callers are
 *  socket 'data' handlers which must not throw. */
export declare function createFrameReader(onMessage: (msg: NotifyMessage) => void, onError?: (err: unknown) => void): (data: Uint8Array) => void;
export {};
