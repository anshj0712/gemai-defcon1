import type { Message, PubSub } from '@google-cloud/pubsub';
import type { Logger } from '@cp/logger';

export interface PulledMessage {
  id: string;
  data: Buffer;
  attributes: Record<string, string>;
  orderingKey: string | undefined;
  deliveryAttempt: number;
}

/** 'ack' removes the message; 'nack' asks Pub/Sub to redeliver it. */
export type PullHandler = (message: PulledMessage) => Promise<'ack' | 'nack'>;

/**
 * Streaming pull from a subscription. Used when the processor runs outside Cloud Run against real
 * GCP (PROCESSOR_PULL=true); on Cloud Run the same subscription is configured for push instead.
 */
export function startPullSubscription(
  pubsub: PubSub,
  subscriptionName: string,
  handler: PullHandler,
  logger: Logger,
  maxMessages = 10,
): { close(): Promise<void> } {
  const subscription = pubsub.subscription(subscriptionName, { flowControl: { maxMessages } });
  subscription.on('message', (m: Message) => {
    void handler({
      id: m.id,
      data: m.data,
      attributes: m.attributes,
      orderingKey: m.orderingKey,
      deliveryAttempt: m.deliveryAttempt ?? 1,
    }).then(
      (outcome) => (outcome === 'ack' ? m.ack() : m.nack()),
      (err: unknown) => {
        logger.error({ err, message_id: m.id }, 'pull handler threw; nacking');
        m.nack();
      },
    );
  });
  subscription.on('error', (err: unknown) => logger.error({ err, subscription: subscriptionName }, 'pull subscription error'));
  logger.info({ subscription: subscriptionName, max_messages: maxMessages }, 'pulling from Pub/Sub');
  return { close: () => subscription.close() };
}
