#!/bin/sh
# Pre-creates the business topics with explicit settings. Idempotent: safe to run on every `up`.
#
# Used by the `kafka-init` one-shot service in infra/docker/docker-compose.dev.yml. It only needs
# the Kafka CLI tools, so the same script can run as a k8s Job in staging/prod (set the env vars).
#
#   KAFKA_BOOTSTRAP        broker address              (default kafka:19092)
#   KAFKA_BIN              dir with kafka-*.sh tools   (default /opt/kafka/bin)
#   TOPIC_REPLICATION      replication factor          (default 1: single dev broker; use 3 in prod)
#
# Coexistence with the worker: apps/worker creates its handler topics and `<topic>.dlq` at startup
# (createTopics, broker-default partitions/RF, no topic configs, skips existing topics). Whichever
# side runs first creates the topic; this script then (re)applies the topic configs with
# `kafka-configs --alter`, which is idempotent, so retention ends up correct in both orders.
# Partition counts are never changed for an existing topic (that would remap message keys);
# a mismatch is only reported.
set -eu

KAFKA_BOOTSTRAP="${KAFKA_BOOTSTRAP:-kafka:19092}"
KAFKA_BIN="${KAFKA_BIN:-/opt/kafka/bin}"
TOPIC_REPLICATION="${TOPIC_REPLICATION:-1}"

SEVEN_DAYS_MS=604800000

# ============================================================================================
# TOPIC LIST: the single source of truth for pre-created topics.
# Format: <topic> <partitions> <comma-separated topic configs, or "-" for broker defaults>
#
# Topic names are the outbox `aggregate_type` values (Debezium routes by it), see
# docs/phase-1-identity-access-design.md §7. Topics carrying PII (email addresses) keep
# 7 days of data; their DLQs hold the same payloads, so they get the same retention.
# ============================================================================================
TOPICS="
identity.user                       3 retention.ms=${SEVEN_DAYS_MS},cleanup.policy=delete
identity.user.dlq                   3 retention.ms=${SEVEN_DAYS_MS},cleanup.policy=delete
users.instructor_application        3 retention.ms=${SEVEN_DAYS_MS},cleanup.policy=delete
users.instructor_application.dlq    3 retention.ms=${SEVEN_DAYS_MS},cleanup.policy=delete
access.user_role                    3 retention.ms=${SEVEN_DAYS_MS},cleanup.policy=delete
access.user_role.dlq                3 retention.ms=${SEVEN_DAYS_MS},cleanup.policy=delete
system.ping                         3 -
"

until "$KAFKA_BIN/kafka-broker-api-versions.sh" --bootstrap-server "$KAFKA_BOOTSTRAP" > /dev/null 2>&1; do
  echo "waiting for kafka at $KAFKA_BOOTSTRAP..."; sleep 2
done

echo "$TOPICS" | while read -r topic partitions configs; do
  [ -z "$topic" ] && continue

  config_args=""
  if [ "$configs" != "-" ]; then
    # kafka-topics --create takes one --config per key=value
    for kv in $(echo "$configs" | tr ',' ' '); do config_args="$config_args --config $kv"; done
  fi

  # shellcheck disable=SC2086 # word splitting of $config_args is intended
  "$KAFKA_BIN/kafka-topics.sh" --bootstrap-server "$KAFKA_BOOTSTRAP" --create --if-not-exists \
    --topic "$topic" --partitions "$partitions" --replication-factor "$TOPIC_REPLICATION" $config_args

  # Topic already existed (e.g. created by the worker or broker auto-create): enforce the configs.
  if [ "$configs" != "-" ]; then
    "$KAFKA_BIN/kafka-configs.sh" --bootstrap-server "$KAFKA_BOOTSTRAP" --alter \
      --entity-type topics --entity-name "$topic" --add-config "$configs" > /dev/null
  fi

  actual=$("$KAFKA_BIN/kafka-topics.sh" --bootstrap-server "$KAFKA_BOOTSTRAP" --describe --topic "$topic" \
    | sed -n 's/.*PartitionCount: *\([0-9]*\).*/\1/p' | head -n 1)
  if [ "$actual" != "$partitions" ]; then
    echo "WARN: $topic has $actual partitions, expected $partitions (not changed automatically)"
  fi
  echo "ok: $topic ($partitions partitions, configs: $configs)"
done

echo "kafka topics ready"
