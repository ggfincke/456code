// apps/server/src/orchestration/Layers/ProjectionSnapshotSql.ts
// sql constants for projection snapshot queries

import {
  COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS,
  IMPORT_CONTINUATION_ACTIVITY_TYPE,
} from '../activityPolicy.ts'

const COMMAND_RELEVANT_THREAD_ACTIVITY_SQL_LIST = COMMAND_RELEVANT_THREAD_ACTIVITY_KINDS.map(
  (kind) => `'${kind}'`,
).join(',\n        ')
export const IMPORT_CONTINUATION_ACTIVITY_SQL_LITERAL = `'${IMPORT_CONTINUATION_ACTIVITY_TYPE}'`

export const COMMAND_THREAD_ACTIVITY_QUERY_SQL = `
  WITH retained_command_activities AS (
    SELECT
      activity_id,
      thread_id,
      turn_id,
      tone,
      kind,
      summary,
      payload_json,
      sequence,
      created_at
    FROM projection_thread_activities AS activity
      INDEXED BY idx_projection_thread_activities_command_relevant
    WHERE activity.kind IN (
        ${COMMAND_RELEVANT_THREAD_ACTIVITY_SQL_LIST}
      )
      AND activity.rowid IN (
        SELECT recent.rowid
        FROM projection_thread_activities AS recent
          INDEXED BY idx_projection_thread_activities_command_window
        WHERE recent.thread_id = activity.thread_id
          AND (
            json_valid(recent.payload_json) = 0
            OR COALESCE(json_extract(recent.payload_json, '$.type'), '')
              <> ${IMPORT_CONTINUATION_ACTIVITY_SQL_LITERAL}
          )
        ORDER BY
          CASE
            WHEN recent.turn_id IS NULL AND recent.sequence IS NOT NULL THEN 0
            ELSE 1
          END DESC,
          CASE
            WHEN recent.turn_id IS NULL AND recent.sequence IS NOT NULL THEN recent.sequence
            ELSE NULL
          END DESC,
          recent.created_at DESC,
          CASE WHEN recent.sequence IS NULL THEN 1 ELSE 0 END DESC,
          recent.sequence DESC,
          CASE
            WHEN substr(recent.kind, -8) = '.started' OR recent.kind = 'tool.started' THEN 0
            WHEN substr(recent.kind, -10) = '.completed'
              OR substr(recent.kind, -9) = '.resolved'
              THEN 2
            ELSE 1
          END DESC,
          recent.activity_id DESC
        LIMIT 500
      )
    UNION ALL
    SELECT
      activity_id,
      thread_id,
      turn_id,
      tone,
      kind,
      summary,
      payload_json,
      sequence,
      created_at
    FROM projection_thread_activities AS marker
      INDEXED BY idx_projection_thread_activities_import_continuation
    WHERE json_valid(marker.payload_json) = 1
      AND json_extract(marker.payload_json, '$.type')
        = ${IMPORT_CONTINUATION_ACTIVITY_SQL_LITERAL}
      AND marker.rowid = (
        SELECT latest_marker.rowid
        FROM projection_thread_activities AS latest_marker
          INDEXED BY idx_projection_thread_activities_import_continuation
        WHERE latest_marker.thread_id = marker.thread_id
          AND json_valid(latest_marker.payload_json) = 1
          AND json_extract(latest_marker.payload_json, '$.type')
            = ${IMPORT_CONTINUATION_ACTIVITY_SQL_LITERAL}
        ORDER BY
          CASE
            WHEN latest_marker.turn_id IS NULL AND latest_marker.sequence IS NOT NULL THEN 0
            ELSE 1
          END DESC,
          CASE
            WHEN latest_marker.turn_id IS NULL AND latest_marker.sequence IS NOT NULL
              THEN latest_marker.sequence
            ELSE NULL
          END DESC,
          latest_marker.created_at DESC,
          CASE WHEN latest_marker.sequence IS NULL THEN 1 ELSE 0 END DESC,
          latest_marker.sequence DESC,
          CASE
            WHEN substr(latest_marker.kind, -8) = '.started'
              OR latest_marker.kind = 'tool.started'
              THEN 0
            WHEN substr(latest_marker.kind, -10) = '.completed'
              OR substr(latest_marker.kind, -9) = '.resolved'
              THEN 2
            ELSE 1
          END DESC,
          latest_marker.activity_id DESC
        LIMIT 1
      )
  )
  SELECT
    activity_id AS "activityId",
    thread_id AS "threadId",
    turn_id AS "turnId",
    tone,
    kind,
    summary,
    payload_json AS "payload",
    sequence,
    created_at AS "createdAt"
  FROM retained_command_activities
  ORDER BY
    thread_id ASC,
    CASE WHEN turn_id IS NULL AND sequence IS NOT NULL THEN 0 ELSE 1 END ASC,
    CASE WHEN turn_id IS NULL AND sequence IS NOT NULL THEN sequence ELSE NULL END ASC,
    created_at ASC,
    CASE WHEN sequence IS NULL THEN 1 ELSE 0 END ASC,
    sequence ASC,
    CASE
      WHEN substr(kind, -8) = '.started' OR kind = 'tool.started' THEN 0
      WHEN substr(kind, -10) = '.completed' OR substr(kind, -9) = '.resolved' THEN 2
      ELSE 1
    END ASC,
    activity_id ASC
`
