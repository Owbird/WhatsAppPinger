// Named run/account states. Kept as constants so records, logs and the report
// never disagree on a string, and so host_lost is never confused with a
// WhatsApp-level halt.
export const STATUS = {
  ENROLLED: "enrolled",
  RUNNING: "running",
  SCHEDULE_COMPLETE: "schedule_complete",

  // Set only when the harness itself observed a WhatsApp-level failure.
  HALTED_PENDING_REVIEW: "halted_pending_review",

  // Set when a heartbeat lapses with no harness-observed failure: the host is
  // asleep, offline or crashed — not necessarily banned.
  HOST_LOST: "host_lost",

  // Manual resolutions of halted_pending_review. Deliberate, separate actions.
  CONFIRMED_BANNED: "confirmed_banned",
  FALSE_ALARM: "false_alarm",
};

export const TERMINAL_STATUSES = [
  STATUS.SCHEDULE_COMPLETE,
  STATUS.CONFIRMED_BANNED,
  STATUS.FALSE_ALARM,
];

export const PENDING_STATUSES = [STATUS.HALTED_PENDING_REVIEW, STATUS.HOST_LOST];

export const ALL_STATUSES = Object.values(STATUS);

export const EVENT_KIND = {
  HALT: "halt",
  GAP: "gap",
  STATUS_TRANSITION: "status_transition",
};
