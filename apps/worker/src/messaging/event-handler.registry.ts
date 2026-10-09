import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { DiscoverableEventHandler } from './event-handler.decorator';
import {
  ANY_EVENT_TYPE,
  isEventHandler,
  type RegisteredEventHandler,
} from './event-handler.interface';

/** Finds every @EventHandler provider once, at startup (before the consumer starts). */
@Injectable()
export class EventHandlerRegistry implements OnModuleInit {
  private readonly logger = new Logger(EventHandlerRegistry.name);
  private handlers: readonly RegisteredEventHandler[] = [];

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    const registered: RegisteredEventHandler[] = [];
    const wrappers = this.discovery.getProviders({ metadataKey: DiscoverableEventHandler.KEY });

    for (const wrapper of wrappers) {
      const metadata = this.discovery.getMetadataByDecorator(DiscoverableEventHandler, wrapper);
      const instance: unknown = wrapper.instance;
      if (!metadata || !isEventHandler(instance)) {
        throw new Error(`${String(wrapper.name)} uses @EventHandler but has no handle() method`);
      }
      const consumerName = metadata.consumerName ?? instance.constructor.name;
      if (registered.some((existing) => existing.consumerName === consumerName)) {
        throw new Error(`Duplicate event handler consumer name "${consumerName}"`);
      }
      registered.push({
        topic: metadata.topic,
        eventType: metadata.eventType,
        consumerName,
        handler: instance,
      });
    }

    this.handlers = registered;
    for (const h of registered) {
      this.logger.log(`Handler ${h.consumerName} -> ${h.topic} / ${h.eventType}`);
    }
  }

  /** Topics the consumer must subscribe to. */
  topics(): string[] {
    return [...new Set(this.handlers.map((h) => h.topic))];
  }

  handlersFor(topic: string, eventType: string): RegisteredEventHandler[] {
    return this.handlers.filter(
      (h) => h.topic === topic && (h.eventType === eventType || h.eventType === ANY_EVENT_TYPE),
    );
  }
}
