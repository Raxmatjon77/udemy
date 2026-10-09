import { describe, expect, it, vi } from 'vitest';
import { ensureTopics, topicsToEnsure } from './kafka-topics';

function fakeAdmin(createTopics = vi.fn().mockResolvedValue(true)) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    createTopics,
  };
}

describe('topicsToEnsure', () => {
  it('adds a DLQ per topic and deduplicates', () => {
    expect(topicsToEnsure(['a', 'b', 'a'])).toEqual(['a', 'a.dlq', 'b', 'b.dlq']);
  });
});

describe('ensureTopics', () => {
  it('creates handler topics and their DLQs with the given settings', async () => {
    const admin = fakeAdmin();

    const ensured = await ensureTopics(admin, ['system.ping'], {
      numPartitions: -1,
      replicationFactor: -1,
    });

    expect(ensured).toEqual(['system.ping', 'system.ping.dlq']);
    expect(admin.createTopics).toHaveBeenCalledWith({
      topics: [
        { topic: 'system.ping', numPartitions: -1, replicationFactor: -1 },
        { topic: 'system.ping.dlq', numPartitions: -1, replicationFactor: -1 },
      ],
    });
    expect(admin.disconnect).toHaveBeenCalledOnce();
  });

  it('treats already existing topics as success (createTopics resolves false)', async () => {
    const admin = fakeAdmin(vi.fn().mockResolvedValue(false));

    await expect(
      ensureTopics(admin, ['system.ping'], { numPartitions: 3, replicationFactor: 1 }),
    ).resolves.toEqual(['system.ping', 'system.ping.dlq']);
  });

  it('disconnects the admin client even when creation fails', async () => {
    const admin = fakeAdmin(vi.fn().mockRejectedValue(new Error('TOPIC_AUTHORIZATION_FAILED')));

    await expect(
      ensureTopics(admin, ['system.ping'], { numPartitions: -1, replicationFactor: -1 }),
    ).rejects.toThrow('TOPIC_AUTHORIZATION_FAILED');
    expect(admin.disconnect).toHaveBeenCalledOnce();
  });
});
