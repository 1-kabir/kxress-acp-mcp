import type { AnyMessage, Stream } from "@agentclientprotocol/sdk";

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
