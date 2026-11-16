--[[
  gv_licence.lua: Global Visions licence check for a CSP track script.

  Reference module, readable on purpose. The track owner wires it into the
  track's own script and obfuscates the result himself. See README.md for the
  full flow and docs/store/CONTRACT.md (sections 5 and 6) for the API.

  Usage from the track script:

    local GvLicence = require('gv_licence')   -- or paste this file in, see README
    GvLicence.init{
      trackId = 'example-circuit',            -- must equal TRACK_ID in gv_licence.ini
      api     = nil,                          -- optional, overrides API= from the ini
      onState = function(state, reason)       -- called on every change
        -- state: 'checking' | 'licensed' | 'grace' | 'locked'
      end
    }
    if GvLicence.isLicensed() then ... end

  Personal data sent to Global Visions: the machine hash (random, opaque, created
  here) and, only if configured, the Steam ID. Nothing else.

  Every CSP API this file is not certain about is marked "-- VERIFY:". The SDK
  definitions checked were github.com/ac-custom-shaders-patch/acc-lua-sdk as of
  August 2026; availability inside a track script ([SCRIPT_...]) was not tested.
]]

local GvLicence = {}

-- ---------------------------------------------------------------------------
-- Constants
-- ---------------------------------------------------------------------------

local GRACE_HOURS_DEFAULT = 72           -- CONTRACT.md 6: recommended offline grace
local DEFAULT_CHECK_SECONDS = 600        -- used if the API omits next_check_in
local MIN_CHECK_SECONDS = 60
local MAX_CHECK_SECONDS = 3600
local MAX_BACKOFF_SECONDS = 1800         -- offline retries: 60, 120, 240 ... up to 30 min

-- How long to wait before asking again after a definitive answer.
local RETRY_AFTER_REASON = {
  no_licence      = 1800,  -- 30 min: maybe the buyer is still checking out
  refunded        = 3600,
  disabled        = 3600,
  machine_limit   = 1800,  -- the buyer may release a machine on the store account page
  too_many_active = 300,   -- "in use" means seen in the last 15 min, so it clears on its own
  bad_request     = 1800,
}

local MACHINE_HASH_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

-- ---------------------------------------------------------------------------
-- Module state
-- ---------------------------------------------------------------------------

local cfg = nil          -- options passed to init, with defaults
local licence = nil      -- values read from gv_licence.ini
local store = nil        -- persistent values (ac.storage)
local token = nil        -- short lived token from /activate (kept in memory only)
local timerId = nil
local backoff = MIN_CHECK_SECONDS
local tokenFailures = 0
local busy = false       -- one request at a time

local state, stateReason = 'checking', 'starting'

-- ---------------------------------------------------------------------------
-- Small helpers
-- ---------------------------------------------------------------------------

local function log(...)
  if cfg and cfg.log then ac.log('[GvLicence]', ...) end
end

local function warn(...)
  if cfg and cfg.log then ac.warn('[GvLicence]', ...) end
end

-- Unix time in seconds, or nil if the clock is not available.
-- VERIFY: os.time() is available in track scripts (it is used widely in CSP's own Lua code,
-- but track scripts are built "withoutIO"; os.time is not IO, so it should be there).
local function now()
  local ok, t = pcall(os.time)
  if ok and type(t) == 'number' and t > 1600000000 then return t end
  return nil
end

local function setState(newState, reason)
  if newState == state and reason == stateReason then return end
  state, stateReason = newState, reason
  log('state', newState, reason)
  if cfg and cfg.onState then
    local ok, err = pcall(cfg.onState, newState, reason)
    if not ok then warn('onState failed:', err) end
  end
end

local function schedule(seconds)
  if timerId then clearTimeout(timerId) end
  -- setTimeout chain rather than setInterval: the period changes with next_check_in and backoff.
  -- setTimeout/clearTimeout are defined in acc-lua-sdk common/internal.lua (all script types).
  timerId = setTimeout(function()
    timerId = nil
    GvLicence.check()
  end, math.max(1, seconds))
end

local function isValidMachineHash(s)
  return type(s) == 'string' and #s >= 32 and #s <= 128 and s:match('^[A-Za-z0-9_%-]+$') ~= nil
end

-- Random, opaque id for this PC. Not derived from hardware, so it carries no
-- information about the machine. It is a tag, not a secret: Lua's PRNG is fine.
local function newMachineHash()
  local seed = (now() or 0) + math.floor((os.preciseClock and os.preciseClock() or os.clock()) * 1000000)
  math.randomseed(seed % 2147483647)
  local out = { 'gvm_' }
  for i = 1, 44 do
    local k = math.random(1, #MACHINE_HASH_ALPHABET)
    out[#out + 1] = MACHINE_HASH_ALPHABET:sub(k, k)
  end
  return table.concat(out)   -- 48 characters of [A-Za-z0-9_]
end

-- ---------------------------------------------------------------------------
-- Reading gv_licence.ini (CONTRACT.md 5)
-- ---------------------------------------------------------------------------

-- Candidate locations, first match wins:
--  1. cfg.iniPath if given
--  2. next to this script (when the script lives in the track's extension folder)
--  3. content/tracks/<track folder>/extension/gv_licence.ini
local function iniCandidates(fileName)
  local list = {}
  if cfg.iniPath and fileName == 'gv_licence.ini' then list[#list + 1] = cfg.iniPath end
  -- VERIFY: __dirname is the folder of the running script in track scripts.
  if type(__dirname) == 'string' and __dirname ~= '' then list[#list + 1] = __dirname .. '/' .. fileName end
  -- VERIFY: ac.getFolder(ac.FolderID.ContentTracks) and ac.getTrackID() (folder name, without layout).
  local ok, path = pcall(function()
    return ac.getFolder(ac.FolderID.ContentTracks) .. '/' .. ac.getTrackID() .. '/extension/' .. fileName
  end)
  if ok and path then list[#list + 1] = path end
  return list
end

local function loadIni(fileName)
  for _, path in ipairs(iniCandidates(fileName)) do
    -- VERIFY: ac.INIConfig.load can read files inside the track folder from a track script.
    -- CSP docs: track scripts "can't read files outside of their folders"; this one is inside.
    local ok, ini = pcall(ac.INIConfig.load, path)
    if ok and ini and ini.sections and ini.sections.LICENCE then
      return ini, path
    end
  end
  return nil
end

local function readLicenceFile()
  local ini, path = loadIni('gv_licence.ini')
  if not ini then return nil, 'no_ini' end

  local data = {
    licenceId = ini:get('LICENCE', 'LICENCE_ID', ''),
    copyId    = ini:get('LICENCE', 'COPY_ID', ''),
    trackId   = ini:get('LICENCE', 'TRACK_ID', ''),
    type      = ini:get('LICENCE', 'TYPE', 'personal'),
    api       = ini:get('LICENCE', 'API', ''),
    path      = path,
  }
  -- SIGNATURE is an HMAC with a server side secret. The client cannot check it and
  -- does not send it; it lets Global Visions prove a leaked file came from them.

  if data.licenceId == '' or not data.licenceId:match('^lic_') then return nil, 'bad_ini' end
  if cfg.trackId and data.trackId ~= cfg.trackId then return nil, 'track_mismatch' end

  -- Commercial licences need the GVC-... key. The venue puts it in a second file it
  -- creates itself, next to gv_licence.ini, or passes it to init().
  if data.type == 'commercial' then
    data.licenceKey = cfg.licenceKey
    if not data.licenceKey then
      local keyIni = loadIni('gv_licence_key.ini')
      data.licenceKey = keyIni and keyIni:get('LICENCE', 'LICENCE_KEY', '') or ''
    end
    if data.licenceKey == '' then data.licenceKey = nil end
  end
  return data
end

-- ---------------------------------------------------------------------------
-- Persistent storage
-- ---------------------------------------------------------------------------

local function openStore()
  -- VERIFY: ac.storage works in track scripts (it writes through CSP to
  -- Documents/Assetto Corsa/cfg/extension/state/lua/<script>, not through io).
  local ok, s = pcall(ac.storage, {
    machineHash = '',     -- opaque id of this PC, created once
    lastOkAt = 0,         -- unix time of the last successful /activate or /validate
    lastOkLicence = '',   -- licence id that last succeeded (a new download resets the grace)
  }, 'gvlic_')
  if ok and s then return s end
  warn('ac.storage unavailable, grace period and machine hash will not persist')
  return { machineHash = '', lastOkAt = 0, lastOkLicence = '' }
end

local function machineHash()
  if not isValidMachineHash(store.machineHash) then
    store.machineHash = newMachineHash()
  end
  return store.machineHash
end

local function withinGrace()
  local t = now()
  local last = tonumber(store.lastOkAt) or 0
  if not t or last <= 0 then return false end
  if store.lastOkLicence ~= licence.licenceId then return false end
  if last > t + 86400 then return false end   -- timestamp from the future: clock was moved back
  return t - last <= cfg.graceHours * 3600
end

-- ---------------------------------------------------------------------------
-- HTTP (CONTRACT.md 6)
-- ---------------------------------------------------------------------------

-- Calls cb(kind, data, retryAfter):
--   kind 'ok'      data = decoded JSON with ok == true
--   kind 'refused' data = decoded JSON with ok == false (data.reason)
--   kind 'offline' data = short text (network error, 5xx, bad JSON)
local function post(path, body, cb)
  local url = cfg.api .. path
  local headers = { ['Content-Type'] = 'application/json', ['Accept'] = 'application/json' }
  -- VERIFY: web.post(url, headers, data, callback(err, response)) with response.status/body/headers
  -- (acc-lua-sdk common/ac_web.lua) is available in track scripts.
  local function onResponse(err, response)
    if err and err ~= '' then return cb('offline', tostring(err)) end
    if not response then return cb('offline', 'no response') end

    local status = tonumber(response.status) or 0
    local retryAfter = response.headers and tonumber(response.headers['retry-after'] or response.headers['Retry-After'])
    if status == 0 or status >= 500 then return cb('offline', 'http ' .. status) end

    local ok, data = pcall(JSON.parse, response.body or '')
    if not ok or type(data) ~= 'table' then return cb('offline', 'bad json, http ' .. status) end

    if data.ok == true then return cb('ok', data) end
    data.reason = data.reason or data.error or 'unknown'
    return cb('refused', data, retryAfter)
  end

  -- If web is missing in this script type, behave like "offline" instead of crashing the track script.
  local ok, err = pcall(function() web.post(url, headers, JSON.stringify(body), onResponse) end)
  if not ok then
    warn('web.post failed:', err)
    setTimeout(function() cb('offline', 'web unavailable') end, 0)
  end
end

local function activationBody()
  local body = {
    track_id = licence.trackId,
    machine_hash = machineHash(),
    licence_id = licence.licenceId,
  }
  if licence.licenceKey then body.licence_key = licence.licenceKey end
  if cfg.includeSteamId then
    -- VERIFY: name of the call returning the current user's SteamID64 as a string.
    -- ac.getUserSteamID() is the expected name; CSP's internal code uses steam.user.getSteamID()
    -- from lua-shared, which a track script may not reach.
    local ok, id = pcall(function() return ac.getUserSteamID() end)
    if ok and type(id) == 'string' and id:match('^%d+$') then body.steam_id = id end
  end
  return body
end

-- ---------------------------------------------------------------------------
-- Outcomes
-- ---------------------------------------------------------------------------

local function onSuccess(data)
  tokenFailures = 0
  backoff = MIN_CHECK_SECONDS
  store.lastOkAt = now() or 0
  store.lastOkLicence = licence.licenceId
  setState('licensed', 'ok')
  local nextIn = tonumber(data.next_check_in) or DEFAULT_CHECK_SECONDS
  schedule(math.min(MAX_CHECK_SECONDS, math.max(MIN_CHECK_SECONDS, nextIn)))
end

-- No usable answer: keep features on while the grace period lasts.
local function onUnreachable(why, retryAfter)
  if withinGrace() then
    setState('grace', why)
  elseif (tonumber(store.lastOkAt) or 0) > 0 then
    setState('locked', 'grace_expired')   -- checked in before, but more than graceHours ago
  else
    setState('locked', why)               -- never checked in successfully on this PC
  end
  local wait = retryAfter or backoff
  backoff = math.min(MAX_BACKOFF_SECONDS, backoff * 2)
  schedule(math.min(MAX_BACKOFF_SECONDS, math.max(MIN_CHECK_SECONDS, wait)))
end

-- A definitive "no" from the API.
local function onRefused(reason)
  if reason == 'no_licence' or reason == 'refunded' or reason == 'disabled' or reason == 'machine_limit' then
    -- Clear the last success so an outage later cannot revive features through the grace period.
    store.lastOkAt = 0
  end
  token = nil
  setState('locked', reason)
  schedule(RETRY_AFTER_REASON[reason] or 1800)
end

local activate   -- forward declaration

local function handleRefusal(data, retryAfter, fromValidate)
  local reason = data.reason

  if reason == 'bad_token' or reason == 'expired_token' or (fromValidate and reason == 'unknown_machine') then
    -- Not a user facing problem: get a fresh token. Guard against loops.
    token = nil
    tokenFailures = tokenFailures + 1
    if tokenFailures <= 2 then return activate() end
    return onUnreachable('token_loop')
  end

  if reason == 'rate_limited' then return onUnreachable('rate_limited', retryAfter) end

  -- bad_request means this script or the ini is wrong. Handled like an outage, so
  -- a script bug never punishes a buyer who checked in successfully before.
  if reason == 'bad_request' then
    warn('API answered bad_request, check gv_licence.ini and the script')
    return onUnreachable('bad_request', RETRY_AFTER_REASON.bad_request)
  end

  if RETRY_AFTER_REASON[reason] then return onRefused(reason) end

  -- A reason this script does not know (contract changed): be lenient.
  warn('unknown reason from API:', reason)
  return onUnreachable('unknown_reason')
end

activate = function()
  busy = true
  post('/activate', activationBody(), function(kind, data, retryAfter)
    busy = false
    if kind == 'ok' then
      token = data.token
      return onSuccess(data)
    elseif kind == 'refused' then
      return handleRefusal(data, retryAfter, false)
    else
      return onUnreachable('offline')
    end
  end)
end

local function validate()
  busy = true
  post('/validate', { token = token }, function(kind, data, retryAfter)
    busy = false
    if kind == 'ok' then return onSuccess(data)
    elseif kind == 'refused' then return handleRefusal(data, retryAfter, true)
    else return onUnreachable('offline') end
  end)
end

-- ---------------------------------------------------------------------------
-- Public API
-- ---------------------------------------------------------------------------

---Start the licence check. Call once, when the track script loads.
---@param options {trackId: string, api: string?, onState: fun(state: string, reason: string)?, iniPath: string?, licenceKey: string?, graceHours: number?, includeSteamId: boolean?, log: boolean?}
function GvLicence.init(options)
  options = options or {}
  cfg = {
    trackId = options.trackId,
    api = options.api,
    onState = options.onState,
    iniPath = options.iniPath,
    licenceKey = options.licenceKey,
    graceHours = tonumber(options.graceHours) or GRACE_HOURS_DEFAULT,
    includeSteamId = options.includeSteamId == true,
    log = options.log ~= false,
  }

  state, stateReason = nil, nil   -- so the first setState below always reaches onState
  store = openStore()

  local data, problem = readLicenceFile()
  if not data then
    -- No ini, a broken ini, or an ini from another track. Extras stay off; driving is untouched.
    setState('locked', problem)
    return
  end
  licence = data

  cfg.api = (cfg.api or licence.api or ''):gsub('/+$', '')
  if not cfg.api:match('^https://') then
    setState('locked', 'no_api')
    return
  end

  -- VERIFY: web.timeouts(resolve, connect, send, receive) in ms. Short timeouts make an
  -- offline PC fall back to the grace period quickly instead of waiting 30 s.
  pcall(function() web.timeouts(4000, 5000, 5000, 8000) end)

  -- At load: a recent success means features can be on straight away while the first
  -- check runs, so a buyer never sees lights flicker off and on.
  if withinGrace() then
    setState('grace', 'cached')
  else
    setState('checking', 'starting')
  end

  activate()
end

---Run a check now (normally called by the timer). /validate if a token is held, else /activate.
function GvLicence.check()
  if not licence or busy then return end
  if token then validate() else activate() end
end

---True while the paid extras should be on ('licensed' or 'grace').
---@return boolean
function GvLicence.isLicensed()
  return state == 'licensed' or state == 'grace'
end

---Current state and reason.
---@return string, string
function GvLicence.getState()
  return state, stateReason
end

---Copy id of this download (for support: lets Global Visions find the licence in admin).
---@return string?
function GvLicence.copyId()
  return licence and licence.copyId
end

---Stop the timer (for example when the script unloads).
function GvLicence.stop()
  if timerId then clearTimeout(timerId) end
  timerId = nil
end

return GvLicence
