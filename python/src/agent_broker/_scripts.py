"""Lua script sources — the shared Redis protocol surface of this library.

These four Lua strings are copied verbatim from the TypeScript implementation, which is this
port's documented source of truth (see ``docs/python-port/ARCHITECTURE.md`` §2: "Option B").
Each one is annotated with the exact TS file it was copied from, at baseline commit `36f7674`.

``tests/unit/test_script_equivalence.py`` extracts the literal Lua string out of each TS source
file and asserts byte-for-byte equality against the strings below, so any future drift between
languages fails loudly in CI rather than silently diverging.

Do not edit the Lua text here without updating the corresponding TypeScript file (or vice
versa) and re-running that equivalence test.
"""

from __future__ import annotations

# Copied from src/admission/request-permission.ts (REQUEST_PERMISSION), lines 90-142.
# 7 KEYS: [1] agent hash [2] budget pool [3] new reservation hash [4] expiring-reservations
# sorted set [5] concurrency counter [6] circuit failure window [7] circuit state.
REQUEST_PERMISSION_SOURCE = """if redis.call('EXISTS', KEYS[1]) == 0 then
  return {0, 'unknown_agent'}
end

local windowMs = tonumber(ARGV[11])
redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', tonumber(ARGV[5]) - windowMs)
local failureCount = redis.call('ZCARD', KEYS[6])
local softThreshold = tonumber(ARGV[12])
local hardThreshold = tonumber(ARGV[13])
local state = redis.call('GET', KEYS[7])

local isProbe = false

if state == 'open' then
  if tonumber(ARGV[15]) < tonumber(ARGV[14]) then
    isProbe = true
  else
    return {0, 'circuit_open', '0'}
  end
elseif failureCount >= hardThreshold then
  redis.call('SET', KEYS[7], 'open')
  return {0, 'circuit_open', '1'}
end

local cost = tonumber(ARGV[2])
local balanceRaw = redis.call('GET', KEYS[2])
local balance = balanceRaw and tonumber(balanceRaw) or 0
if balance < cost then
  return {0, 'budget_exceeded'}
end

local limit = tonumber(ARGV[10])
local inFlightRaw = redis.call('GET', KEYS[5])
local inFlight = inFlightRaw and tonumber(inFlightRaw) or 0
if inFlight >= limit then
  return {0, 'concurrency_exceeded'}
end

redis.call('DECRBY', KEYS[2], cost)
redis.call('INCR', KEYS[5])
redis.call('HSET', KEYS[3],
  'agentId', ARGV[1], 'budgetKey', ARGV[8], 'target', ARGV[3],
  'estimatedCost', cost, 'createdAt', ARGV[5], 'isProbe', isProbe and '1' or '0')
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[4]) + tonumber(ARGV[9]))
redis.call('ZADD', KEYS[4], tonumber(ARGV[5]) + tonumber(ARGV[4]), ARGV[6])
redis.call('HSET', KEYS[1], 'lastHeartbeat', ARGV[5])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[7]))

if failureCount >= softThreshold and failureCount < hardThreshold then
  local retryAfter = math.floor(windowMs / (hardThreshold - softThreshold + 1))
  return {1, retryAfter}
end
return {1}"""
REQUEST_PERMISSION_NUM_KEYS = 7

# Copied from src/admission/resolve-reservation.ts (RESOLVE_RESERVATION), lines 54-119.
# 6 KEYS: [1] reservation hash [2] budget pool [3] concurrency counter
# [4] expiring-reservations sorted set [5] circuit failure window [6] circuit state.
RESOLVE_RESERVATION_SOURCE = """
local r = redis.call('HMGET', KEYS[1], 'resolved', 'estimatedCost', 'budgetKey', 'target', 'isProbe')
if not r[2] then
  return {0, 'unknown_reservation'}
end
if r[1] == '1' then
  return {0, 'already_resolved'}
end

local estimatedCost = tonumber(r[2])
local success = ARGV[2] == '1'
local costGiven = ARGV[3] == '1'
local retryable = ARGV[6] == '1'
local feedsCircuit = ARGV[8] == '1'
local isProbe = r[5] == '1'
local refund
local costUnknown = 0

if costGiven then
  refund = estimatedCost - tonumber(ARGV[4])
elseif success then
  refund = 0
  costUnknown = 1
else
  refund = estimatedCost
end

local poolMissing = 0
if refund ~= 0 then
  if redis.call('EXISTS', KEYS[2]) == 1 then
    redis.call('INCRBY', KEYS[2], refund)
  else
    poolMissing = 1
  end
end

redis.call('DECR', KEYS[3])
redis.call('HSET', KEYS[1], 'resolved', '1', 'resolvedAt', ARGV[5], 'costUnknown', tostring(costUnknown))
redis.call('ZREM', KEYS[4], ARGV[1])

local opened = '0'
if feedsCircuit and not success and retryable then
  redis.call('ZADD', KEYS[5], ARGV[5], ARGV[1])
  redis.call('ZREMRANGEBYSCORE', KEYS[5], '-inf', tonumber(ARGV[5]) - tonumber(ARGV[7]))

  local hardThreshold = tonumber(ARGV[9])
  local currentState = redis.call('GET', KEYS[6])
  if currentState ~= 'open' then
    local failureCount = redis.call('ZCARD', KEYS[5])
    if failureCount >= hardThreshold then
      redis.call('SET', KEYS[6], 'open')
      opened = '1'
    end
  end
end

if isProbe and feedsCircuit then
  if success then
    redis.call('SET', KEYS[6], 'closed')
    redis.call('DEL', KEYS[5])
    return {1, costUnknown, poolMissing, '1', opened}
  end
end

return {1, costUnknown, poolMissing, '0', opened}
"""
RESOLVE_RESERVATION_NUM_KEYS = 6

# Copied from src/agents/register-child.ts (REGISTER_CHILD), lines 31-45.
# 2 KEYS: [1] parent agent hash [2] new child agent hash.
REGISTER_CHILD_SOURCE = """
local parent = redis.call('HMGET', KEYS[1], 'depth', 'rootId', 'budgetKey')
if not parent[1] then
  return {0, 'unknown_agent'}
end
local depth = tonumber(parent[1]) + 1
if depth > tonumber(ARGV[2]) then
  return {0, 'depth_exceeded'}
end
redis.call('HSET', KEYS[2],
  'parentId', ARGV[1], 'depth', depth, 'rootId', parent[2], 'budgetKey', parent[3],
  'createdAt', ARGV[4], 'lastHeartbeat', ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[3])
return {1, depth, parent[2], parent[3]}
"""
REGISTER_CHILD_NUM_KEYS = 2

# Copied from src/budget/add-budget.ts (ADD_BUDGET), lines 121-127.
# 1 KEY: [1] budget pool.
ADD_BUDGET_SOURCE = """
if redis.call('EXISTS', KEYS[1]) == 0 then
  return {0, 'unknown_budget'}
end
local newBalance = redis.call('INCRBY', KEYS[1], ARGV[1])
return {1, newBalance}
"""
ADD_BUDGET_NUM_KEYS = 1
