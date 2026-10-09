import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";
import type {
  AnyMessage as AnyV2Message,
  AnyWireMessage,
  Stream as V2Stream,
} from "@agentclientprotocol/sdk/experimental/v2";

export function interceptSessionUpdates(
  stream: Stream,
  receive: (params: unknown) => void,
): Stream {
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyMessage, AnyMessage>({
      transform(message, controller) {
        if (
          "method" in message && message.method === "session/update" &&
          !("id" in message)
        ) {
          const params = message.params;
          if (
            params && typeof params === "object" &&
            typeof (params as { sessionId?: unknown }).sessionId === "string"
          ) {
            receive(params);
          } else {
            console.error(
              "Consumed unrouteable ACP session/update notification",
            );
          }
          return;
        }
        controller.enqueue(message);
      },
    }),
  );
  return { readable, writable: stream.writable };
}

export function interceptV2SessionUpdates(
  stream: V2Stream,
  receive: (params: unknown) => void,
): V2Stream {
  const readable = stream.readable.pipeThrough(
    new TransformStream<AnyWireMessage, AnyWireMessage>({
      transform(message, controller) {
        const batch = Array.isArray(message);
        const entries: readonly AnyV2Message[] = batch
          ? message as readonly AnyV2Message[]
          : [message as AnyV2Message];
        const remaining: AnyV2Message[] = [];
        for (const entry of entries) {
          if (
            "method" in entry && entry.method === "session/update" &&
            !("id" in entry)
          ) {
            const params = entry.params;
            if (
              params && typeof params === "object" &&
              typeof (params as { sessionId?: unknown }).sessionId === "string"
            ) {
              receive(params);
            } else {
              console.error(
                "Consumed unrouteable ACP v2 session/update notification",
              );
            }
            continue;
          }
          remaining.push(entry);
        }
        if (remaining.length === 0) return;
        if (batch) {
          controller.enqueue(remaining as unknown as AnyWireMessage);
        } else controller.enqueue(remaining[0]);
      },
    }),
  );
  return { readable, writable: stream.writable };
}
