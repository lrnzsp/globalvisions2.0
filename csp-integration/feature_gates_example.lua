--[[
  feature_gates_example.lua: how a track script switches the paid extras on and
  off from GvLicence's onState. Basic driving is never touched.

  Node and mesh names are placeholders: use the names from your own KN5.
]]

local GvLicence = require('gv_licence')   -- VERIFY: require() of a sibling file in a track script

-- Handles to scene objects, found once.
-- ac.findNodes / ac.findMeshes, :setVisible and :setMaterialProperty are used widely in CSP's own
-- scripts. VERIFY that the names and properties below match your track.
local lightNodes = ac.findNodes('GV_LIGHTS_?')           -- light poles, grandstand lights...
local lightMeshes = ac.findMeshes('GV_LAMP_EMISSIVE_?')   -- emissive lamp surfaces
local animatedNodes = ac.findNodes('GV_ANIM_?')          -- flags, cranes, crowd cards...

local Features = { lights = false, animations = false, grip = false, timing = false }

local function setLights(on)
  lightNodes:setVisible(on)
  lightMeshes:setMaterialProperty('ksEmissive', on and vec3(20, 18, 15) or vec3(0, 0, 0))
end

local function setAnimations(on)
  -- Example: hide the animated set pieces, or stop advancing them in script.update().
  animatedNodes:setVisible(on)
end

local function setEvolvingGrip(on)
  -- The owner's own grip evolution. When off, the track keeps the static grip from
  -- surfaces.ini, so the car drives exactly as it would without the extra.
  -- VERIFY: whatever CSP mechanism your grip evolution uses (no single API is assumed here).
end

local function setTiming(on)
  -- Example: custom timing towers / sector boards drawn by this script.
end

local function apply(on)
  if Features.lights ~= on then setLights(on) end
  if Features.animations ~= on then setAnimations(on) end
  if Features.grip ~= on then setEvolvingGrip(on) end
  if Features.timing ~= on then setTiming(on) end
  Features.lights, Features.animations, Features.grip, Features.timing = on, on, on, on
end

-- Start with everything off, then let the licence state decide.
setLights(false); setAnimations(false); setEvolvingGrip(false); setTiming(false)

GvLicence.init{
  trackId = 'example-circuit',
  onState = function(state, reason)
    -- 'licensed' and 'grace' mean on, 'checking' and 'locked' mean off.
    apply(state == 'licensed' or state == 'grace')
    if state == 'locked' then
      ac.log('Global Visions extras are off (' .. tostring(reason) .. '). Licence: https://globalvisions.it/store/')
    end
  end
}

function script.update(dt)
  if Features.animations then
    -- advance your animations here
  end
end
