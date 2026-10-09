import { applyDecorators, Injectable } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import type { EventHandlerMetadata } from './event-handler.interface';

/** Typed metadata decorator that DiscoveryService can search for. */
export const DiscoverableEventHandler = DiscoveryService.createDecorator<EventHandlerMetadata>();

export interface EventHandlerOptions {
  /**
   * Idempotency key stored in outbox.processed_events. Defaults to the class name, so
   * renaming the class would make it re-process old events; pin it once it is in production.
   */
  consumerName?: string;
}

/**
 * Marks a provider as a Kafka event handler:
 *
 *   @EventHandler('catalog.course', 'CoursePublished')
 *   export class ReindexCourseHandler implements EventHandlerContract { ... }
 *
 * Add the class to some module's `providers`; the registry discovers it at startup and the
 * consumer subscribes to its topic.
 */
export function EventHandler(
  topic: string,
  eventType: string,
  options: EventHandlerOptions = {},
): ClassDecorator {
  return applyDecorators(
    Injectable(),
    DiscoverableEventHandler({ topic, eventType, consumerName: options.consumerName }),
  );
}
