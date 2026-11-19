# Booking MCP reschedule guard — change record

**Branch:** `platform/ru-adaptation`  
**Change commit:** `a437dc08fc5fe447be8ca960fad909e0568477cf`  
**Scope:** MCP booking update tool only.

## Problem

Upstream `lib/mcp/tools/bookings.ts` allowed `bookings_update` to write `startTime` and `endTime` directly to the database. That mutation did not call the public booking availability/capacity checks. An integration with `bookings:write` could therefore move an appointment into a slot that is unavailable or already occupied.

## Change made in this branch

- Removed `startTime` and `endTime` from the MCP tool's published input schema.
- Updated the tool description so it no longer advertises rescheduling.
- Added a defensive handler check that rejects time changes if they are passed directly, before any database update.
- Preserved non-time edits such as notes, status, guest contact fields and assignee.
- Updated `tests/unit/mcp-tools-bookings.test.ts` to assert that time fields are not exposed and a direct time-change attempt returns an error without writing.

## Important limitation

This is a **fail-closed mitigation**, not the final shared booking service. Rescheduling through this MCP tool is temporarily unavailable. The portal's existing status/notes/assignee endpoint still does not provide a shared domain service. The public booking flow continues to use its existing availability/capacity checks.

## Verification status

The modified source and test files were read back from the fork after commit and the expected guard/test text was confirmed. The unit test, typecheck, lint and integration suite have **not** been executed in this environment. Do not describe this change as test-passing until CI or a local Bun test run confirms it.

## Next implementation

1. Extract the canonical availability/capacity and conflict rules into a reusable booking domain layer.
2. Add transactional create/reschedule/cancel/reassign operations with race-safe capacity enforcement.
3. Route public booking, client portal, agency-assisted operations and MCP through that layer.
4. Add cross-channel and concurrent-booking integration tests.
5. Restore MCP rescheduling only after the shared service and regression tests pass.
