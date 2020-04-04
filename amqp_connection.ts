import { AmqpSocket } from "./framing/socket.ts";
import { AmqpChannel, openChannel } from "./amqp_channel.ts";
import {
  AmqpProtocol,
  ConnectionCloseArgs,
  HARD_ERROR_CONNECTION_FORCED
} from "./amqp_protocol.ts";

export interface AmqpConnectionOptions {
  username: string;
  password: string;
  heartbeatInterval?: number;
}

const NULL_CHAR = String.fromCharCode(0);
function credentials(username: string, password: string) {
  return `${NULL_CHAR}${username}${NULL_CHAR}${password}`;
}

export interface AmqpConnection {
  close(): Promise<void>;
  openChannel(): Promise<AmqpChannel>;
}

export function openConnection(
  socket: AmqpSocket,
  options: AmqpConnectionOptions
): Promise<AmqpConnection> {
  const { username, password } = options;
  let heartbeatInterval: number | undefined = undefined;
  const channels: { channelNumber: number }[] = [];
  let channelMax: number = -1;
  let frameMax: number = -1;
  const protocol: AmqpProtocol = new AmqpProtocol(socket);

  protocol.subscribeConnectionClose(0, async args => {
    await protocol.sendConnectionCloseOk(0, {});
    console.error(
      "Connection closed by server ",
      JSON.stringify(args)
    );
    socket.close();
  });

  async function open() {
    await socket.start();

    await protocol.receiveConnectionStart(0);
    await protocol.sendConnectionStartOk(0, {
      clientProperties: {},
      response: credentials(username, password)
    });

    await protocol.receiveConnectionTune(0).then(
      async args => {
        const interval = heartbeatInterval !== undefined
          ? heartbeatInterval
          : args.heartbeat;

        channelMax = args.channelMax;
        frameMax = args.frameMax;

        await protocol.sendConnectionTuneOk(0, {
          heartbeat: interval,
          channelMax: channelMax,
          frameMax: frameMax
        });

        socket.tuneHeartbeat(interval);
      }
    );

    await protocol.sendConnectionOpen(0, {});
  }

  async function close(args?: Partial<ConnectionCloseArgs>) {
    await protocol.sendConnectionClose(0, {
      classId: args?.classId || 0,
      methodId: args?.methodId || 0,
      replyCode: args?.replyCode || HARD_ERROR_CONNECTION_FORCED,
      replyText: args?.replyText
    });
    socket.close();
  }

  function removeChannel(channelNumber: number) {
    const index = channels.findIndex(x => x.channelNumber === channelNumber);
    if (index !== -1) {
      channels.splice(index, index + 1);
    }
  }

  async function createChannel(): Promise<AmqpChannel> {
    for (let i = 1; i < channelMax; ++i) {
      if (!channels.find(c => c.channelNumber === i)) {
        channels.push({ channelNumber: i });

        const channel = await openChannel(i, protocol, closeArgs => {
          console.log(
            `Channel ${i} closed by server ${JSON.stringify(closeArgs)}`
          );
          removeChannel(i);
        });

        return channel;
      }
    }

    throw new Error(`Maximum channels ${channelMax} reached`);
  }

  const connection: AmqpConnection = { close, openChannel: createChannel };

  return new Promise<AmqpConnection>(async resolve => {
    await open();
    return resolve(connection);
  });
}
