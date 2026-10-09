// ───────────────────────────────────────────────────────────────────────────────
// CHAITRA - CITY HEAT ACTION INTELLIGENCE AND RISK ATLAS
// URBAN HEAT ANALYSIS FOR INDIAN CITIES - WITH EMAIL ACCESS CONTROL
// FOR GUIDANCE PURPOSES ONLY
// ───────────────────────────────────────────────────────────────────────────────
//
// 🔒 ACCESS CONTROL POLICY:
// - Public Cities (no email required): Agra
// - Protected Cities (email required once per session): All others (14 cities)
// - Email valid for: Current browser session only
// - All access logged to: Google Sheets + Console
//
// 📋 SETUP INSTRUCTIONS:
// 1. Update ACCESS_LOG_URL with your Google Sheets Apps Script deployment URL
// 2. Configure PUBLIC_CITIES array to add/remove public cities
// 3. Test in GEE Code Editor (console logging works immediately)
// 4. Deploy as GEE App for full Google Sheets logging functionality
//
// Last Modified: August 31, 2026
// ───────────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────────
// 0. USER SETTINGS & GLOBAL CONFIG

// Global variables
var cityBoundary;
var wards;
var cityName = 'Varanasi';  // Auto-loaded for NRDC India dashboard
var startDate = '2022-04-01';  // 3+ years (April 2022 to July 2025)
var endDate = '2025-07-31';    // Recent data through summer 2025
var summerFilter = ee.Filter.calendarRange(4, 7, 'month');

var lst, ndvi, uhi, lulc, nightlights, urbanData;
var computeCache = {};

// ═══════════════════════════════════════════════════════════════════════════════
// ⚡ PRECOMPUTED ASSET CACHE (cross-session extension of computeCache)
//
// The analysis window is FIXED and historical (2022-04 → 2025-07), so every
// city's composites are frozen: recomputing them per session is pure waste.
// Workflow:
//   1. In the CODE EDITOR set ADMIN_EXPORT_MODE = true, run, pick a city,
//      click "⚡ Export city cache assets" (sidebar), run the 2 tasks in the
//      Tasks tab (composite ~30m + albedo ~10m).
//   2. When both tasks finish, add the city to ASSET_CACHE.cities below and
//      redeploy the app. Cities NOT listed fall back to full computation, so
//      rollout can be one city at a time.
//   3. If the METHODOLOGY changes (dates, cloud masking, albedo formula),
//      bump ASSET_CACHE.version, re-export, and update cities[] — a stale
//      asset would otherwise silently pin the old math.
// Outputs are identical: every downstream reduceRegion pins its own scale
// (30m/10m), which matches the assets' native scale exactly.
// ═══════════════════════════════════════════════════════════════════════════════
var ADMIN_EXPORT_MODE = false;  // true ONLY in Code Editor to show export button

var ASSET_CACHE = {
  enabled: true,
  root: 'projects/uhi-delhi/assets/chaitra_cache',  // NOTE: uhi-delhi, not
  // gee-piyushn44 - this login can read the ward assets project but cannot
  // create assets in it ('earthengine.assets.create' denied, Sep 2026).
  // IMPORTANT: before adding cities to the list below, share this folder
  // as publicly readable (Assets tab -> chaitra_cache -> Share -> Anyone
  // can read) so deployed-app visitors can load the cached images.
  // v2 (Oct 2026): population summed on WorldPop's native grid and the
  // cool-roof table takes its population from the shared ward table. Every
  // v1 asset carries the old (under/over-counted) numbers: delete, never reuse.
  version: 'v2',
  // Cities whose composite assets exist for THIS version. A listed city whose
  // asset is missing fails every layer with "Image asset ... not found".
  // All 15 cities' landsat_composite_v2 + albedo_v2 exported 2026-10-08
  // via "Export ALL cities" (verified in the Assets folder). If the folder is
  // ever cleared again, set this to [] until the 30 tasks are re-run.
  cities: ['Ayodhya', 'Varanasi', 'Bhubaneswar', 'Agra', 'Kolkata', 'Surat',
           'Lucknow', 'Chennai', 'Jaipur', 'Ahmedabad', 'Mumbai', 'Hyderabad',
           'Bangalore', 'Delhi', 'Bhopal'],
  // Cities whose HEAT-RISK WARD TABLE export has completed. Separate list
  // because this product is exported per-city (run the city, then click the
  // single-city export button) - see exportCityCacheAssets.
  heatRiskCities: [],
  // Cities with the FULL LAYER-RESULTS bundle cached: every layer's finished
  // ward table (LST, population risk, cool roof, tree planting, activity,
  // informal housing, heat risk) plus the 10m informal-housing raster.
  // A listed city loads these instead of computing any layer from scratch.
  // Export per-city via exportCityCacheAssets (8 tasks per city).
  // NOTE: names must match cityConfigs keys exactly ('Bangalore', not 'Bengaluru').
  // TEMPORARILY EMPTY (Sep 2026): coolroof_wards + tree_wards methodology
  // changed (dark threshold 0.15, plantable fraction in ward saplings), so the
  // cached tables for Agra/Lucknow/Mumbai/Bangalore/Delhi are stale. Cities
  // return here one by one as their re-exports complete.
  layerCities: []
};

function cityHasLayerCache(city) {
  return ASSET_CACHE.enabled && ASSET_CACHE.layerCities.indexOf(city) > -1;
}

function cacheAssetId(city, product) {
  return ASSET_CACHE.root + '/' + city + '_' + product + '_' + ASSET_CACHE.version;
}

function cityIsPrecomputed(city) {
  return ASSET_CACHE.enabled && ASSET_CACHE.cities.indexOf(city) > -1;
}

var computationState = {
  isRunning: false,
  currentCity: null,
  // Email access control fields
  emailVerified: false,
  verifiedEmail: null
};

// Debug flag for troubleshooting
var DEBUG_MODE = false;

// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 ACCESS CONTROL CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

// Public cities (no email verification required)
var PUBLIC_CITIES = ['Agra'];

// Google Sheets logging endpoint (Apps Script Web App URL)
// ✅ CONFIGURED: Connected to CHAITRA Access Log spreadsheet
var ACCESS_LOG_URL = 'https://script.google.com/macros/s/AKfycbypA2oJCir8TUpykByre_-JZZa6GMi3ADrmPnUPEcSB9odrvkjPI5381x9kYEahpa4I/exec';

// Session state for email tracking
var accessState = {
  emailProvided: false,
  userEmail: null,
  userName: null,
  userOrg: null,
  sessionStart: null
};

// UI elements for email collection (defined globally for access across functions)
var emailPanel, emailInput, emailStatusLabel, emailErrorLabel, continueButton;
var emailHeaderLabel;  // global: runAnalysis sets it to 'Unlock <City>'
var changeDetailsButton;  // stage 2 'change details' action
var nameInput, orgInput;  // identity fields shown with the email prompt
var verifyLinkLabel, codeInput, codeErrorLabel, codeButton, otpInstructionLabel;  // verification-step widgets
var accessDeniedMsg = null;  // Access denied message widget (managed globally)
var pendingCity = null;  // city requested while the gate is up; cityName stays on the
                         // last analysed city until the code is verified

// ═══════════════════════════════════════════════════════════════════════════════

var mapPanel, sidePanel, layerSelect, citySelect, legendSection, descSection;
var currentLayerLabel;  // cityLabel removed - using citySelect dropdown instead
var priorityPanel, priorityButton, priorityContent;

var wardPriorities = {};

// Request counters: each async evaluate() callback compares the value it
// captured against the live counter and bails out if a newer update has
// started since, so a slow response for a previous layer/city can never
// overwrite the panel that is now on screen.
var priorityRequestId = 0;
var descRequestId = 0;

// Global loading indicator (reused to prevent multiple messages)
var globalLoadingLabel = null;
var globalLoadingTimer = null;

// ✅ MULTI-CITY CONFIGURATION
var cityConfigs = {
  'Ayodhya': {
    assetPath: 'projects/gee-piyushn44/assets/Ayodhya_wards_cleaned',
    utmZone: 'EPSG:32644',  // Ayodhya is in UP, UTM zone 44
    zoomLevel: 13,
    bbox: [82.15, 26.75, 82.25, 26.85],
    areaKm2: 70  // Ayodhya municipal area (approximate)
  },
  'Varanasi': {
    assetPath: 'projects/gee-piyushn44/assets/Varanasi_Ward_Map',
    utmZone: 'EPSG:32644',  // Varanasi falls in UTM zone 44, not 43
    zoomLevel: 12,
    bbox: [82.91, 25.22, 83.07, 25.38],
    areaKm2: 82  // Varanasi municipal area is roughly 80-82 km²
  },
  'Bhubaneswar': {
    assetPath: 'projects/gee-piyushn44/assets/Bhubneshwar_Ward_BND',
    utmZone: 'EPSG:32645',
    zoomLevel: 12,
    bbox: [85.80, 20.22, 85.88, 20.32],
    areaKm2: 135
  },
  'Agra': {
    assetPath: 'projects/gee-piyushn44/assets/Agra_Wards',
    utmZone: 'EPSG:32644',  // FIXED: Agra bbox (77.95–78.10°E) straddles zone 43/44 boundary at 78°E
                             // Zone 44 (78–84°E) is better fit for most of city (>78°E)
    zoomLevel: 12,
    bbox: [77.95, 27.10, 78.10, 27.25],
    areaKm2: 188
  },
  'Kolkata': {
    assetPath: 'projects/gee-piyushn44/assets/Kolkata_Ward_Map',
    utmZone: 'EPSG:32645',
    zoomLevel: 12,
    bbox: [88.30, 22.47, 88.42, 22.65],
    areaKm2: 205
  },
  'Surat': {
    assetPath: 'projects/gee-piyushn44/assets/Surat_Ward_Map',
    utmZone: 'EPSG:32643',
    zoomLevel: 12,
    bbox: [72.78, 21.15, 72.92, 21.25],
    areaKm2: 327
  },
  'Lucknow': {
    assetPath: 'projects/gee-piyushn44/assets/Lucknow_Ward_Map',
    utmZone: 'EPSG:32644',
    zoomLevel: 12,
    bbox: [80.85, 26.78, 81.00, 26.92],
    areaKm2: 349
  },
  'Chennai': {
    assetPath: 'projects/gee-piyushn44/assets/Chennai_Ward_Map',
    utmZone: 'EPSG:32644',
    zoomLevel: 12,
    bbox: [80.18, 12.97, 80.30, 13.15],
    areaKm2: 426
  },
  'Jaipur': {
    assetPath: 'projects/gee-piyushn44/assets/Jaipur_Ward_Map',
    utmZone: 'EPSG:32643',
    zoomLevel: 12,
    bbox: [75.75, 26.85, 75.88, 26.97],
    areaKm2: 485
  },
  'Ahmedabad': {
    assetPath: 'projects/gee-piyushn44/assets/Ahmedabad_Ward_Map',
    utmZone: 'EPSG:32643',
    zoomLevel: 12,
    bbox: [72.50, 22.98, 72.68, 23.12],
    areaKm2: 505
  },
  'Mumbai': {
    assetPath: 'projects/gee-piyushn44/assets/Mumbai_Ward_Map',
    utmZone: 'EPSG:32643',
    zoomLevel: 12,
    bbox: [72.78, 18.89, 72.98, 19.28],
    areaKm2: 603
  },
  'Hyderabad': {
    assetPath: 'projects/gee-piyushn44/assets/Hyderabad_Ward_Map',
    utmZone: 'EPSG:32644',
    zoomLevel: 12,
    bbox: [78.36, 17.32, 78.55, 17.52],
    areaKm2: 650
  },
  'Bangalore': {
    assetPath: 'projects/gee-piyushn44/assets/Bangalorewardmap',
    utmZone: 'EPSG:32643',
    zoomLevel: 12,
    bbox: [77.50, 12.90, 77.70, 13.08],
    areaKm2: 741
  },
  'Delhi': {
    assetPath: 'projects/gee-piyushn44/assets/Delhi_Ward_Map',
    utmZone: 'EPSG:32643',
    zoomLevel: 12,
    bbox: [76.84, 28.40, 77.35, 28.90],
    areaKm2: 1484
  },
  'Bhopal': {
    assetPath: 'projects/uhi-delhi/assets/bhopal_wards',
    utmZone: 'EPSG:32643',  // Bhopal (~77.4°E) sits inside UTM zone 43 (72-78°E)
    zoomLevel: 12,
    bbox: [77.32, 23.17, 77.53, 23.33],
    areaKm2: 463  // Bhopal Municipal Corporation area (approximate)
  }
};

// State-City mapping for ward-level data export
var cityStateMapping = {
  'Ayodhya': 'Uttar Pradesh',
  'Varanasi': 'Uttar Pradesh',
  'Bhubaneswar': 'Odisha',
  'Agra': 'Uttar Pradesh',
  'Kolkata': 'West Bengal',
  'Surat': 'Gujarat',
  'Lucknow': 'Uttar Pradesh',
  'Chennai': 'Tamil Nadu',
  'Jaipur': 'Rajasthan',
  'Ahmedabad': 'Gujarat',
  'Mumbai': 'Maharashtra',
  'Hyderabad': 'Telangana',
  'Bangalore': 'Karnataka',
  'Delhi': 'Delhi',
  'Bhopal': 'Madhya Pradesh'
};

var scales = {
  lst: 30,         // Landsat thermal true scale
  ndvi: 30,        // Landsat reflectance true scale
  population: 100  // WorldPop native-ish
};

var water = ee.Image('JRC/GSW1_4/GlobalSurfaceWater').select('occurrence');

var wardResults;

// ✅ LAYER-SPECIFIC STATS CACHE: Each layer loads independently
// Prevents single point of failure and enables progressive loading
var layerStatsCache = {
  population: { status: 'pending', data: null, error: null },
  coolRoof: { status: 'pending', data: null, error: null },
  treePlanting: { status: 'pending', data: null, error: null },
  activity: { status: 'pending', data: null, error: null },
  heatRisk: { status: 'pending', data: null, error: null }
};
// Status values: 'pending' (not started), 'loading' (in progress), 'success' (loaded), 'error' (failed)


// ═══════════════════════════════════════════════════════════════════════════════
// RESOURCE CONFIGURATION - Centralized assumptions for all quantification
// ═══════════════════════════════════════════════════════════════════════════════
var RESOURCE_CONFIG = {
  // Emergency Response (Population Exposure Priority)
  emergency: {
    // Cooling Shelters (by priority) - UPDATED TO YOUR REQUIREMENTS
    coolingSheltersPerPop: {
      high: 17500,      // 1 shelter per 15,000-20,000 pop (using 17,500 as midpoint)
      medium: 20000,    // 1 shelter per 20,000 pop (medium-risk)
      low: 30000        // 1 shelter per 30,000 pop (low-risk)
    },
    coolingShelterCost: 150000,   // Rs 1.5 lakh per cooling shelter (matches panel text)

    // Vulnerable population fraction
    vulnerableFraction: 0.22,  // 22% of ward pop (Census 2011 Varanasi: children 0-6 = 11.3%, elderly 60+ ~8%, pregnant ~2.5%)

    // ORS & Rehydration - UPDATED TO YOUR REQUIREMENTS
    orsPacketsPerVulnerable: 5,         // 5 packets per vulnerable person per 5-day event (WHO)
    orsCostPerPacket: 7,                // Rs. 7/packet (NHM government procurement rate)
    rehydrationStationsPerPop: 10000,   // 1 station per 10,000 total population (drinking water stations)

    // Drinking Water
    waterLitersPerPersonDay: 3,         // 3L/person/day for TOTAL population (Sphere 2018)

    // Frontline Workers (existing capacity, not procurement)
    ashaWorkersPerPop: 1000,            // 1 per 1,000 urban pop (NUHM Guidelines)
    anganwadiWorkersPerPop: 1000,       // 1 per 1,000 pop (ICDS norms)

    // Medical Preparedness - Heat illness estimates (relaxed)
    heatIllnessRate_lower: 0.001,       // 0.1% of vulnerable pop (NPCCHH/MoHFW 2024)
    heatIllnessRate_upper: 0.005,       // 0.5% of vulnerable pop (Azhar et al. 2014)
    hospitalizationRate: 0.05,          // 5% of heat illness cases need hospital beds (relaxed from 10%)

    // Heat illness beds - NEW METRIC
    heatIllnessBedsPerExposed: 10000,   // 1 bed per 10,000 exposed residents (planning benchmark)

    // Ambulances (derived from peak daily severe cases, relaxed)
    ambulanceTripsPerDay: 6,            // EMRI 108 can handle ~6 trips/day (relaxed from 4)
    heatWaveDurationDays: 7             // 7-day heat wave for peak daily calculation (relaxed from 5)
  },

  // Tree Planting Programs
  tree: {
    targetCanopyPercent: 20,            // 20% urban canopy (URDPFI 2014: 12-18% minimum; MoHUA 2014 best practice)

    // Plantable fraction of deficit area (by ward density)
    plantableFraction: {
      high: 0.20,     // 20% plantable in densest wards
      medium: 0.25,   // 25% plantable in medium density
      low: 0.30       // 30% plantable in lower density
    },

    treesPerPlantableHa: 400,           // 400 trees/ha mixed urban (Karnataka agroforestry norm)
    survivalRate3Year: 0.74,            // ~74% with dedicated maintenance
    // Derived from survivalRate3Year, NOT hardcoded: plant 1/0.74 = 1.351x the
    // target so the survivors actually equal the target. The previous literal
    // 1.35 was fractionally short, so the panel's own numbers never reconciled.
    mortalityBuffer: 1 / 0.74,          // = 1.351 (~35% extra) for ~74% survival

    // Cost components
    saplingCost_min: 150,               // Rs 150-300 (State Forest Dept nursery rates)
    saplingCost_max: 300,
    plantingLaborCost: 230,             // Rs 230/tree (1 MNREGA person-day, UP wage 2024-25)
    maintenanceCost3Year: 300,          // Rs 300/tree (3-year watering, protection)
    costPerTree_mid: 750,               // Midpoint total cost per tree

    // Location breakdown (GoI scheme norms)
    avenueFraction: 0.40,               // 40% avenue/road (IRC:SP:21-2009)
    parkFraction: 0.25,                 // 25% parks (URDPFI 2014 / AMRUT)
    nagarVanFraction: 0.15,             // 15% Nagar Van patches (Nagar Van Yojana/CAMPA)
    institutionalFraction: 0.20,        // 20% institutions (URDPFI 2014)

    // Phasing (3-year rollout)
    year1Fraction: 0.50,                // 50% Year 1 (nursery + monsoon planting)
    year2Fraction: 0.30,                // 30% Year 2 (gap filling)
    year3Fraction: 0.20,                // 20% Year 3 (mortality replacement)
    nurseryLeadTimeMonths: 8,           // State Forest Dept procurement cycle

    // Shade structures (for wards too dense for trees)
    shadeStructuresPerKmRoad: 2,        // 1 per 500m major road
    urbanRoadDensityKmPerKm2: 3.5       // Typical urban road network density
  },

  // Nighttime Activity / 24-Hour Worker Protection
  activity: {
    rehydrationStationsPerPop: 10000,   // 1 per 10,000 population at high-footfall locations
    orsPacketsPerStation: 5000,         // 5,000 ORS packets per station (seasonal stockpile)
    mistingStationsPerKm2: 0.5,         // 1 per 2 km² activity area (0.5/km²)
    mistingCooling_C: 4,                // 3-5°C local cooling
    shadeNetsPerKm2: 0.5,               // ~24 installations of 100 m² each over market corridors
    shadeNetSize_m2: 100,               // 100 m² per installation
    shadeNetCostMin: 15000,             // Rs. per 100 sq.m installation
    shadeNetCostMax: 25000,             // Rs. per 100 sq.m installation
    uphcPerPopulation: 50000            // 1 UPHC per 50,000 population (NUHM norm)
  },

  // ═══════════════════════════════════════════════════════════════════════
  // WARD-BASED RESOURCE ALLOCATION (Per Ward, Not Per Capita)
  // ═══════════════════════════════════════════════════════════════════════
  wardBased: {
    emergency: {
      coolingShelters: { high: 2, medium: 1, low: 0.5 },
      rehydrationStations: { high: 2, medium: 1, low: 0.5 },
      orsPacketsPerStation: 5000,
      ambulancesPerHighWards: 4
    },
    activity: {
      shadeNets: { high: 2, medium: 1, low: 0.5 },
      mistingStations: { high: 1, medium: 0.5, low: 0.25 }
    },
    informal: {
      waterTaps: { high: 8, medium: 4, low: 2 },
      toiletBlocks: { high: 2, medium: 1, low: 0.5 }
    }
  }

};

// ═══════════════════════════════════════════════════════════════════════════════
// RESOURCE CALCULATION HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate emergency response resources for heat risk by population
 * NEW SPEC: Cooling shelters, ORS for vulnerable, water, frontline workers, medical preparedness
 *
 * @param {number} exposedPopulation - Number of people exposed to heat
 * @param {string} priorityLevel - 'high', 'medium', or 'low'
 * @returns {Object} Resource requirements with confidence levels
 */

/**
 * Calculate emergency response resources BY WARD (ward-priority-based, not per capita)
 * SIMPLIFIED APPROACH: Clear per-ward ratios, no zeros for any tier
 *
 * @param {Object} wardCounts - { high: N, medium: N, low: N } ward counts by priority
 * @param {Object} populations - { high: N, medium: N, low: N, total: N } populations by priority
 * @returns {Object} Resource requirements with tier breakdown
 */
function calculateEmergencyResourcesByWard(wardCounts, populations) {
  var wardConfig = RESOURCE_CONFIG.wardBased.emergency;
  var config = RESOURCE_CONFIG.emergency;

  var numHigh = Number(wardCounts.high) || 0;
  var numMedium = Number(wardCounts.medium) || 0;
  var numLow = Number(wardCounts.low) || 0;
  var totalPop = Number(populations.total) || 0;

  // ═══════════════════════════════════════════════════════════════════
  // 1. COOLING SHELTERS (Ward-Based)
  // ═══════════════════════════════════════════════════════════════════
  var coolingShelters = {
    high: Math.round(numHigh * wardConfig.coolingShelters.high),
    medium: Math.round(numMedium * wardConfig.coolingShelters.medium),
    low: Math.ceil(numLow * wardConfig.coolingShelters.low),
    total: 0
  };
  coolingShelters.total = coolingShelters.high + coolingShelters.medium + coolingShelters.low;

  var coolingShelterCost = coolingShelters.total * config.coolingShelterCost;
  var coolingShelterCostLakhs = coolingShelterCost / 100000;

  // ═══════════════════════════════════════════════════════════════════
  // 2. REHYDRATION STATIONS (Ward-Based)
  // ═══════════════════════════════════════════════════════════════════
  var rehydrationStations = {
    high: Math.round(numHigh * wardConfig.rehydrationStations.high),
    medium: Math.round(numMedium * wardConfig.rehydrationStations.medium),
    low: Math.ceil(numLow * wardConfig.rehydrationStations.low),
    total: 0
  };
  rehydrationStations.total = rehydrationStations.high + rehydrationStations.medium + rehydrationStations.low;

  // ═══════════════════════════════════════════════════════════════════
  // 3. ORS PACKETS (Simple: Per Station)
  // ═══════════════════════════════════════════════════════════════════
  var orsPackets = rehydrationStations.total * wardConfig.orsPacketsPerStation;
  var orsCost = orsPackets * config.orsCostPerPacket;
  var orsCostLakhs = orsCost / 100000;

  // ═══════════════════════════════════════════════════════════════════
  // 4. DRINKING WATER (Population-Based - Keep Simple)
  // ═══════════════════════════════════════════════════════════════════
  var waterLitersDaily = totalPop * config.waterLitersPerPersonDay;

  // ═══════════════════════════════════════════════════════════════════
  // 5. FRONTLINE WORKERS (Population-Based)
  // ═══════════════════════════════════════════════════════════════════
  var ashaWorkers = Math.ceil(totalPop / config.ashaWorkersPerPop);
  var anganwadiWorkers = Math.ceil(totalPop / config.anganwadiWorkersPerPop);

  // ═══════════════════════════════════════════════════════════════════
  // 6. MEDICAL PREPAREDNESS (Population-Based)
  // ═══════════════════════════════════════════════════════════════════
  var heatIllnessRate_lower = config.heatIllnessRate_lower;
  var heatIllnessRate_upper = config.heatIllnessRate_upper;

  // Rates are documented as % of the VULNERABLE population (children,
  // elderly, pregnant = vulnerableFraction), so apply them to that base
  var vulnerablePop = Math.round(totalPop * config.vulnerableFraction);
  var heatIllnessCases_lower = Math.round(vulnerablePop * heatIllnessRate_lower);
  var heatIllnessCases_upper = Math.round(vulnerablePop * heatIllnessRate_upper);

  var hospitalizationRate = config.hospitalizationRate;
  var hospitalBeds_lower = Math.ceil(heatIllnessCases_lower * hospitalizationRate);
  var hospitalBeds_upper = Math.ceil(heatIllnessCases_upper * hospitalizationRate);

  var heatIllnessBeds = Math.ceil(totalPop / config.heatIllnessBedsPerExposed);

  var peakDailySevereCases_lower = Math.max(1, Math.ceil(hospitalBeds_lower / config.heatWaveDurationDays));
  var peakDailySevereCases_upper = Math.max(1, Math.ceil(hospitalBeds_upper / config.heatWaveDurationDays));

  // ═══════════════════════════════════════════════════════════════════
  // 7. AMBULANCES (Ward-Based: High Priority Only)
  // ═══════════════════════════════════════════════════════════════════
  var ambulancesToPrePosition = Math.ceil(numHigh / wardConfig.ambulancesPerHighWards);

  return {
    // Infrastructure (with tier breakdown)
    coolingShelters: coolingShelters,
    coolingShelterCostLakhs: coolingShelterCostLakhs,
    rehydrationStations: rehydrationStations,

    // Supplies
    orsPackets: orsPackets,
    orsCostLakhs: orsCostLakhs,
    waterLitersDaily: waterLitersDaily,

    // Personnel
    ashaWorkers: ashaWorkers,
    anganwadiWorkers: anganwadiWorkers,

    // Medical
    heatIllnessCases_lower: heatIllnessCases_lower,
    heatIllnessCases_upper: heatIllnessCases_upper,
    hospitalBeds_lower: hospitalBeds_lower,
    hospitalBeds_upper: hospitalBeds_upper,
    heatIllnessBeds: heatIllnessBeds,
    peakDailySevereCases_lower: peakDailySevereCases_lower,
    peakDailySevereCases_upper: peakDailySevereCases_upper,
    ambulancesToPrePosition: ambulancesToPrePosition,

    // BACKWARD COMPATIBILITY ALIASES
    coolingCenters: coolingShelters.total,
    vulnerablePop: vulnerablePop
  };
}

/**
 * Calculate cool roof program resources
 * NEW SPEC: Satellite-measured dark BUILT SURFACE area (roofs + roads + courtyards)
 *           + Estimated rooftop area (50% of total) + URDPFI government building estimates + coating cost
 *
 * @param {number} darkBuiltArea_m2 - Total dark built surface area (all impervious surfaces)
 * @param {number} buildingCountMin - Minimum building count estimate
 * @param {number} buildingCountMax - Maximum building count estimate
 * @param {number} totalPopulation - Total population in the area
 * @returns {Object} Resource requirements with confidence levels
 */
function calculateCoolRoofResources(darkBuiltArea_m2, buildingCountMin, buildingCountMax, totalPopulation) {
  var pop = Number(totalPopulation) || 0;
  var darkBuiltTotal = Number(darkBuiltArea_m2) || 0;
  var countMin = Number(buildingCountMin) || 0;
  var countMax = Number(buildingCountMax) || 0;

  // SATELLITE-DERIVED: Dark built surface area (ALL impervious surfaces)
  var darkBuiltArea_ha = darkBuiltTotal / 10000;

  // ESTIMATED ROOFTOP AREA: 50% of total dark built surface
  // (Satellite cannot distinguish roofs from roads/courtyards/paved areas)
  var ROOF_FRACTION = 0.50;
  var estimatedRoofArea_m2 = darkBuiltTotal * ROOF_FRACTION;
  var estimatedRoofArea_ha = estimatedRoofArea_m2 / 10000;

  // Cost calculations based on ESTIMATED ROOFTOP AREA ONLY
  var costMin_Crores = (estimatedRoofArea_m2 * 150) / 10000000;
  var costMax_Crores = (estimatedRoofArea_m2 * 230) / 10000000;

  // Single indicative building estimate (blended 70 m² median rooftop)
  var countEst = Math.ceil(estimatedRoofArea_m2 / 70);

  // PHASE 1 — GOVERNMENT BUILDINGS (URDPFI 2014 population norms)
  var primarySchools = Math.ceil(pop / 5000);
  var healthCenters = Math.ceil(pop / 30000);
  var communityHalls = Math.ceil(pop / 10000);
  var govtCount = primarySchools + healthCenters + communityHalls;

  // Government roof area from standard building sizes
  // Primary school: 500m² (CPWD standard design)
  // UPHC: 200m² (IPHS 2022 Vol III)
  // Community hall: 300m² (URDPFI 2014 typical)
  var govtRoofArea_m2 = (primarySchools * 500) +
                         (healthCenters * 200) +
                         (communityHalls * 300);
  // Government roofs cannot exceed the dark rooftop area actually measured
  // in these wards. If the population norms imply more roof than exists,
  // Phase 1 is capped at the measured area, Phase 2 is honestly zero and the
  // panel says so (govtCapped). Before the population fix this cap was hit
  // in every city because the cool-roof population was ~10x inflated, which
  // is why Phase 2 read zero.
  var govtRoofAreaNorm_m2 = govtRoofArea_m2;
  var govtCapped = govtRoofArea_m2 > estimatedRoofArea_m2;
  if (govtCapped) govtRoofArea_m2 = estimatedRoofArea_m2;
  var govtCostMin_Lakhs = (govtRoofArea_m2 * 150) / 100000;
  var govtCostMax_Lakhs = (govtRoofArea_m2 * 230) / 100000;

  // PHASE 2 — RESIDENTIAL & COMMERCIAL
  // Everything that is not a government roof. Counts are derived from the
  // REMAINING AREA at the same 120 / 70 / 30 m² rooftop assumptions as the
  // headline range; subtracting a government building COUNT (avg ~410 m²
  // each) from a 120 m²-based count mixed two different roof sizes.
  var residentialArea_m2 = Math.max(0, estimatedRoofArea_m2 - govtRoofArea_m2);
  var residentialCountMin = Math.ceil(residentialArea_m2 / 120);
  var residentialCountEst = Math.ceil(residentialArea_m2 / 70);
  var residentialCountMax = Math.ceil(residentialArea_m2 / 30);
  var residentialCostMin_Crores = (residentialArea_m2 * 150) / 10000000;
  var residentialCostMax_Crores = (residentialArea_m2 * 230) / 10000000;

  return {
    // Satellite-derived (ALL dark impervious surfaces)
    darkBuiltArea_m2: darkBuiltTotal,
    darkBuiltArea_ha: darkBuiltArea_ha,

    // Estimated rooftop area (50% of dark built surface)
    estimatedRoofArea_m2: estimatedRoofArea_m2,
    estimatedRoofArea_ha: estimatedRoofArea_ha,

    // Cost based on estimated rooftop area
    costMin_Crores: costMin_Crores,
    costMax_Crores: costMax_Crores,

    // Building count range
    buildingCountMin: countMin,
    buildingCountMax: countMax,
    buildingCountEst: countEst,

    // Phase 1 — Government
    govtCount: govtCount,
    primarySchools: primarySchools,
    healthCenters: healthCenters,
    communityHalls: communityHalls,
    govtRoofArea_m2: govtRoofArea_m2,            // capped at measured rooftop area
    govtRoofAreaNorm_m2: govtRoofAreaNorm_m2,    // uncapped population-norm figure
    govtCapped: govtCapped,
    govtCostMin_Lakhs: govtCostMin_Lakhs,
    govtCostMax_Lakhs: govtCostMax_Lakhs,

    // Phase 2 — Residential
    residentialArea_m2: residentialArea_m2,
    residentialCountMin: residentialCountMin,
    residentialCountEst: residentialCountEst,
    residentialCountMax: residentialCountMax,
    residentialCostMin_Crores: residentialCostMin_Crores,
    residentialCostMax_Crores: residentialCostMax_Crores
  };
}


/**
 * Calculate tree planting program resources
 * NEW SPEC: Canopy deficit + shade structures + planting plan + location breakdown + phasing + cost
 *
 * @param {number} deficitHectares - Canopy deficit in hectares
 * @param {number} totalPopulation - Total population in the area
 * @param {string} priorityTier - 'high', 'medium', or 'low' (affects plantable fraction)
 * @param {number} wardAreaKm2 - Ward area in km² (for shade structure calculation)
 * @param {number} canopyFrac - Current canopy fraction 0-1 (for shade structure qualification)
 * @param {number} builtFrac - Built fraction 0-1 (for shade structure qualification)
 * @returns {Object} Resource requirements with confidence levels
 */
function calculateTreeResources(deficitHectares, totalPopulation, priorityTier, wardAreaKm2, canopyFrac, builtFrac) {
  var config = RESOURCE_CONFIG.tree;
  var deficit = Number(deficitHectares) || 0;
  var pop = Number(totalPopulation) || 0;
  var tier = (priorityTier || 'medium').toLowerCase();
  var areaKm2 = Number(wardAreaKm2) || 0;
  var canopy = Number(canopyFrac) || 0;
  var built = Number(builtFrac) || 0;

  // 1. SHADE STRUCTURES (for wards too dense for trees)
  // Only for wards with canopy <10% AND built >50%
  var shadeStructures = 0;
  if (canopy < 0.10 && built > 0.50 && areaKm2 > 0) {
    var majorRoadKm = areaKm2 * config.urbanRoadDensityKmPerKm2;
    shadeStructures = Math.ceil(majorRoadKm * config.shadeStructuresPerKmRoad);
  }

  // 2. TREES NEEDED
  // Plantable fraction depends on ward density tier
  var plantableFraction = config.plantableFraction[tier] || config.plantableFraction.medium;
  // Trees that would close the measured gap outright (400/ha = 25 m² crown)
  var treesToCloseGap = Math.ceil(deficit * config.treesPerPlantableHa);
  // Only the plantable share of the missing-canopy area can actually be
  // planted in a built-up ward, so the program closes that share of the gap
  var plantableHa = deficit * plantableFraction;
  var treesNeeded = Math.ceil(plantableHa * config.treesPerPlantableHa);
  var gapClosedPct = Math.round(plantableFraction * 100);

  // 3. SAPLINGS TO PLANT (with mortality buffer)
  var saplingsToPlant = Math.ceil(treesNeeded * config.mortalityBuffer);
  var expectedSurvivors = Math.ceil(saplingsToPlant * config.survivalRate3Year);

  // 4. LOCATION BREAKDOWN (GoI scheme norms)
  var avenueTrees = Math.ceil(saplingsToPlant * config.avenueFraction);
  var parkTrees = Math.ceil(saplingsToPlant * config.parkFraction);
  var nagarVanTrees = Math.ceil(saplingsToPlant * config.nagarVanFraction);
  var institutionalTrees = Math.ceil(saplingsToPlant * config.institutionalFraction);

  // 5. PHASING (3-year rollout)
  var year1Saplings = Math.ceil(saplingsToPlant * config.year1Fraction);
  var year2Saplings = Math.ceil(saplingsToPlant * config.year2Fraction);
  var year3Saplings = saplingsToPlant - year1Saplings - year2Saplings;

  // 6. COST
  var costPerTree = config.costPerTree_mid;  // Rs 750
  var costMinLakhs = (saplingsToPlant * config.saplingCost_min + saplingsToPlant * (config.plantingLaborCost + config.maintenanceCost3Year)) / 100000;
  var costMaxLakhs = (saplingsToPlant * config.saplingCost_max + saplingsToPlant * (config.plantingLaborCost + config.maintenanceCost3Year)) / 100000;
  var costMidLakhs = (saplingsToPlant * costPerTree) / 100000;

  // RETURN OBJECT
  return {
    // Core metrics
    deficitHectares: deficit,
    shadeStructures: shadeStructures,
    treesToCloseGap: treesToCloseGap,
    plantableFraction: plantableFraction,
    gapClosedPct: gapClosedPct,
    treesNeeded: treesNeeded,
    saplingsToPlant: saplingsToPlant,
    expectedSurvivors: expectedSurvivors,

    // Location breakdown
    avenueTrees: avenueTrees,
    parkTrees: parkTrees,
    nagarVanTrees: nagarVanTrees,
    institutionalTrees: institutionalTrees,

    // Phasing
    year1Saplings: year1Saplings,
    year2Saplings: year2Saplings,
    year3Saplings: year3Saplings,

    // Cost
    costPerTree: costPerTree,
    costMinLakhs: costMinLakhs,
    costMaxLakhs: costMaxLakhs,
    costMidLakhs: costMidLakhs,

    // BACKWARD COMPATIBILITY ALIASES
    totalSaplingsToPlant: saplingsToPlant,
    streetTrees: avenueTrees,
    schoolTrees: institutionalTrees,
    costMinCrores: costMinLakhs / 100,
    costMaxCrores: costMaxLakhs / 100,
    costMidCrores: costMidLakhs / 100,
    totalCostCrores: costMidLakhs / 100
  };
}


/**
 * Calculate nighttime activity / 24-hour worker protection resources
 * Removes fabricated worker population estimates, uses defensible infrastructure ratios
 *
 * NOTE: Worker population CANNOT be estimated from nightlights. This function now
 * flags that as requiring local input (employer surveys, travel demand models).
 *
 * @param {number} activeAreaKm2 - Area with 24-hour activity in km²
 * @param {number} majorRoadKm - Major road length in km
 * @returns {Object} Resource requirements with confidence levels
 */
function calculateActivityResources(activeAreaKm2, majorRoadKm, totalPopulation) {
  var config = RESOURCE_CONFIG.activity;
  var area = Number(activeAreaKm2) || 0;
  var roadKm = Number(majorRoadKm) || 10; // Default 10 km if not provided
  var pop = Number(totalPopulation) || 0;

  // Rehydration Stations - 1 per 10,000 population (same as Pop Heat Risk)
  var rehydrationStations = Math.ceil(pop / config.rehydrationStationsPerPop);

  // Misting Stations - 1 per 2 km² activity area (High tier only)
  var mistingStations = Math.ceil(area * config.mistingStationsPerKm2);

  // Shade Nets - 1 per km² activity area (High/Medium tier)
  var shadeNets = Math.ceil(area * config.shadeNetsPerKm2);

  // Extended-Hours Clinics - 1 per 50,000 population (NUHM norm)
  var extendedHoursClinics = Math.ceil(pop / config.uphcPerPopulation);

  return {
    // Rehydration stations
    rehydrationStations: rehydrationStations,

    // Misting stations (High tier only)
    mistingStations: mistingStations,

    // Shade nets for markets
    shadeNets: shadeNets,

    // Extended-hours clinics
    extendedHoursClinics: extendedHoursClinics,

    // Backward compatibility aliases
    activeAreaKm2: area,
    estimatedWorkers: 0,  // Explicitly removed - not defensible from nightlights
    busStops: 0,          // Removed from spec
    waterPoints: rehydrationStations,
    mistingCooling_C: config.mistingCooling_C
  };
}


/**
 * Safe getter for dictionary values with fallback
 * @param {Object} obj - Object to get value from
 * @param {string} key - Key to retrieve
 * @param {number} defaultVal - Default value if key is missing/invalid
 * @returns {number} Value or default
 */
function safeGet(obj, key, defaultVal) {
  if (!obj) return defaultVal;
  var val = obj[key];
  if (val === undefined || val === null || isNaN(Number(val))) {
    return defaultVal;
  }
  return Number(val);
}

/**
 * Safe evaluation wrapper with error handling
 * @param {ee.ComputedObject} eeObject - Earth Engine object to evaluate
 * @param {function} successCallback - Callback for successful evaluation
 * @param {function} errorCallback - Callback for errors (optional)
 */

// ───────────────────────────────────────────────────────────────────────────────
// 1. CONFIGURABLE PARAMETERS

var params = {
  visualization: {
    // ═══════════════════════════════════════════════════════════════════════
    // LST (LAND SURFACE TEMPERATURE): Thermometer colors
    // Purpose: Show absolute temperature - hotter areas are redder
    // Palette: Pale yellow (cool) → bright yellow → orange → deep red (hot)
    // Contextual meaning: Classic heat visualization like weather maps
    // ═══════════════════════════════════════════════════════════════════════
    lst: {
      bands: ['LST'],
      min: 20,
      max: 55,
      palette: ['#FFFBEA', '#FFF176', '#FFB74D', '#FF9800', '#F57C00', '#E64A19', '#BF360C'],
      unit: '°C'
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SUHI (SURFACE URBAN HEAT ISLAND): Enhanced high-resolution palette
    // Purpose: Show heat anomaly with maximum color detail
    // Palette: Purple (cool islands) → blue → WHITE at 0°C → yellow → orange → red (hot)
    // FULL RANGE: -5°C to +20°C with white neutral point at 0°C baseline
    // ENHANCED: 50 colors = 0.5°C per color step for maximum visible detail
    // ═══════════════════════════════════════════════════════════════════════
    uhi: {
      bands: ['UHI'],
      min: -5,
      max: 20,
      palette: [
        // -5 to 0°C: Cool islands (purples to blues) - 10 colors leading to WHITE
        '#4A148C',  // -5.0°C - Deep purple (cool islands: parks, water)
        '#6A1B9A',  // -4.5°C - Purple
        '#7B1FA2',  // -4.0°C - Medium purple
        '#8E24AA',  // -3.5°C - Light purple
        '#9C27B0',  // -3.0°C - Bright purple
        '#1A237E',  // -2.5°C - Navy blue
        '#283593',  // -2.0°C - Deep blue
        '#3949AB',  // -1.5°C - Blue
        '#42A5F5',  // -1.0°C - Light blue
        '#81D4FA',  // -0.5°C - Sky blue

        // 0°C: BASELINE - WHITE (neutral reference point)
        '#FFFFFF',  // 0.0°C - White (baseline - coolest vegetated areas)

        // 0 to 5°C: Slight warming (pale yellow transition) - 10 colors
        '#FFFDE7',  // 0.5°C - Pale cream
        '#FFF9C4',  // 1.0°C - Very pale yellow
        '#FFF59D',  // 1.5°C - Pale yellow
        '#FFF176',  // 2.0°C - Light yellow
        '#FFEE58',  // 2.5°C - Yellow
        '#FFEB3B',  // 3.0°C - Bright yellow
        '#FFE082',  // 3.5°C - Gold-yellow
        '#FFD54F',  // 4.0°C - Gold
        '#FFCA28',  // 4.5°C - Deep gold
        '#FFC107',  // 5.0°C - Amber-gold

        // 5 to 10°C: Moderate warming (yellows to oranges) - 10 colors
        '#FFB300',  // 5.5°C - Amber
        '#FFA726',  // 6.0°C - Light orange
        '#FF9800',  // 6.5°C - Orange
        '#FB8C00',  // 7.0°C - Medium orange
        '#F9A825',  // 7.5°C - Deep gold-orange
        '#F57F17',  // 8.0°C - Burnt gold
        '#FF8F00',  // 8.5°C - Deep amber
        '#FF6F00',  // 9.0°C - Deep orange
        '#EF6C00',  // 9.5°C - Burnt orange
        '#F57C00',  // 10.0°C - Dark orange

        // 10 to 15°C: High heat (oranges to red-oranges) - 10 colors
        '#E65100',  // 10.5°C - Very dark orange
        '#F4511E',  // 11.0°C - Red-orange
        '#FF5722',  // 11.5°C - Bright red-orange
        '#E64A19',  // 12.0°C - Orange-red
        '#DD2C00',  // 12.5°C - Dark orange-red
        '#D84315',  // 13.0°C - Red
        '#D32F2F',  // 13.5°C - Medium red
        '#C62828',  // 14.0°C - Deep red
        '#BF360C',  // 14.5°C - Dark red
        '#B71C1C',  // 15.0°C - Very dark red

        // 15 to 20°C: Extreme hotspots (dark reds) - 9 colors
        '#A52714',  // 15.5°C - Crimson
        '#991B1B',  // 16.0°C - Dark crimson
        '#8B0000',  // 16.5°C - Dark red
        '#7F1D1D',  // 17.0°C - Very dark red
        '#6B0000',  // 17.5°C - Deep crimson
        '#5F0000',  // 18.0°C - Extremely dark red
        '#4D0000',  // 18.5°C - Near black red
        '#3D0000',  // 19.0°C - Almost black
        '#2D0000'   // 19.5-20°C - Darkest red (extreme hotspot)
      ],
      unit: '°C'
    },

    // ═══════════════════════════════════════════════════════════════════════
    // NDVI (VEGETATION INDEX): Soil-to-forest gradient
    // Purpose: Show vegetation health and density
    // Palette: Brown/tan (bare soil) → yellow-green (sparse veg) → forest green (dense canopy)
    // Contextual meaning: Natural progression from bare earth to lush vegetation
    // ═══════════════════════════════════════════════════════════════════════
    ndvi: {
      min: 0,
      max: 0.8,
      palette: ['#A67C52', '#C4B088', '#D4D48C', '#B8D98C', '#8BC48C', '#66A366', '#2D7A2D']
    },

    // ═══════════════════════════════════════════════════════════════════════
    // POPULATION EXPOSURE PRIORITY: Safety signal colors (traffic light metaphor)
    // Purpose: Identify wards with most people at risk from heat
    // Palette: Green (safe) → Yellow (caution) → Red (danger)
    // Contextual meaning: Universal safety signaling - red means immediate action needed
    // ═══════════════════════════════════════════════════════════════════════
    popExposure: {
      min: 1,
      max: 3,
      palette: ['#66BB6A', '#FDD835', '#E53935'],  // Green, Yellow, Red
      categories: ['Low Risk', 'Medium Risk', 'High Risk'],
      categorical: true  // ✅ Force categorical legend rendering
    },

    // ═══════════════════════════════════════════════════════════════════════
    // COOL ROOF PRIORITY: Albedo-based (dark surfaces need intervention)
    // Purpose: Where cool roof programs will have most impact
    // Palette: Light cyan (already cool) → Gray (moderate) → Dark brown (hot, high priority)
    // Contextual meaning: Dark surfaces are hot and need cooling interventions
    // ═══════════════════════════════════════════════════════════════════════
    CoolRoof: {
      min: 1,
      max: 3,
      palette: ['#B3E5FC', '#90A4AE', '#4E342E'],
      categories: ['Low Priority', 'Medium Priority', 'High Priority']
    },

    // ═══════════════════════════════════════════════════════════════════════
    // TREE CANOPY GAPS: Inverse vegetation (brown = need trees)
    // Purpose: Where urban greening is most needed
    // Palette: Dark green (has trees) → Yellow-green → Brown (needs trees urgently)
    // Contextual meaning: Brown/tan areas lack vegetation and need planting
    // ═══════════════════════════════════════════════════════════════════════
    greenGaps: {
      min: 1,
      max: 3,
      palette: ['#2E7D32', '#9CCC65', '#A1887F'],
      categories: ['Low Priority', 'Medium Priority', 'High Priority']
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ECONOMIC ACTIVITY ZONES: Nighttime activity intensity
    // Purpose: Areas with high nighttime activity (workers exposed to heat)
    // Palette: Dark blue (low activity) → Gold (moderate) → Bright yellow (high activity)
    // Contextual meaning: Like city lights - brighter = more economic activity at night
    // ═══════════════════════════════════════════════════════════════════════
    economicZones: {
      min: 1,
      max: 3,
      palette: ['#1A237E', '#FFD54F', '#FFA726'],  // Dark Blue → Light Yellow → Dark Yellow
      categories: ['Low Priority', 'Moderate Priority', 'High Priority']
    },

    // ═══════════════════════════════════════════════════════════════════════
    // INFORMAL HOUSING: Area-fraction based (non-linear for right-skewed distribution)
    // Purpose: Show % of ward's built area classified as informal/vulnerable
    // Palette: NON-LINEAR to match area-fraction distribution
    //   - Compress 0-20: 2 pale colors (most wards have low informal %)
    //   - Expand 50-100: 8 colors (gold → dark brown for high-risk areas)
    // Contextual meaning: Dark brown = large portion of ward is informal settlement
    // 11-color palette for finer discrimination
    // ═══════════════════════════════════════════════════════════════════════
    informalHousing: {
      min: 0,
      max: 100,
      palette: [
        // Multi-hue browns: Yellow-brown → Orange-brown → Red-brown
        // Moderate saturation (30-60%) to differentiate from LST's vibrant colors
        // 0-20: PALE CREAM/BEIGE - Almost invisible (low density fades)
        '#FDFBF7',  // 0-5: Almost white with warm cream hint
        '#F9F5EC',  // 5-10: Very pale cream
        '#F5EFE0',  // 10-15: Pale beige
        '#F0E8D3',  // 15-20: Light beige
        // 20-40: LIGHT YELLOW-BROWN - Tan/sand tones
        '#EBE0C5',  // 20-25: Light tan
        '#E5D7B6',  // 25-30: Tan
        '#DFCDA6',  // 30-35: Medium tan
        '#D8C295',  // 35-40: Golden tan
        // 40-60: ORANGE-BROWN - Hue shift to warmer tones (medium density)
        '#D1B683',  // 40-45: Light orange-brown
        '#C9A871',  // 45-50: Orange-brown
        '#C0995F',  // 50-55: Medium orange-brown
        '#B6894D',  // 55-60: Deep orange-brown
        // 60-80: RED-BROWN - Rust/terra cotta tones (high density)
        '#AB783D',  // 60-65: Rust brown
        '#9F672F',  // 65-70: Red-brown
        '#925623',  // 70-75: Deep red-brown
        '#84461A',  // 75-80: Dark rust
        // 80-100: DARK RED-BROWN - Mahogany/chocolate (extreme density)
        '#753712',  // 80-85: Mahogany
        '#65290C',  // 85-90: Dark mahogany
        '#551C08',  // 90-95: Very dark chocolate
        '#441005',  // 95-100: Almost black brown
      ],
      unit: 'score (0-100)'
    },

    // ═══════════════════════════════════════════════════════════════════════
    // HEAT RISK INDEX (VULNERABILITY): Warning progression
    // Purpose: Overall heat vulnerability combining multiple factors
    // Palette: Pale yellow (safe) → Amber (warning) → Deep red (critical)
    // Contextual meaning: Escalating warning colors like heat advisories
    // ═══════════════════════════════════════════════════════════════════════
    vulnerability: {
      min: 0,
      max: 1,
      palette: ['#FFFDE7', '#FFF9C4', '#FFF176', '#FFEB3B', '#FFC107', '#FF9800', '#FF5722', '#D32F2F'],
      unit: 'risk score'
    },
    // ═══════════════════════════════════════════════════════════════════════
    // LAND USE (LULC): Natural color associations
    // Purpose: Show different land cover types
    // Palette: Each class uses its natural color (green=trees, blue=water, gray=urban, etc.)
    // Contextual meaning: Intuitive recognition - colors match what you'd see from above
    // ═══════════════════════════════════════════════════════════════════════
    lulc: {
      categorical: true,
      min: 10,
      max: 100,
      palette: [
        '#1B5E20', '#7CB342', '#C5E1A5', '#FDD835', '#757575',
        '#D7CCC8', '#FFFFFF', '#1976D2', '#4FC3F7', '#00695C', '#B9F6CA'
      ],
      categories: [
        'Tree cover', 'Shrubland', 'Grassland', 'Cropland', 'Built-up',
        'Bare/sparse vegetation', 'Snow and ice', 'Permanent water bodies',
        'Herbaceous wetland', 'Mangroves', 'Moss and lichen'
      ]
    },

    // ═══════════════════════════════════════════════════════════════════════
    // NIGHTLIGHTS: Night sky to city lights
    // Purpose: Nighttime illumination intensity
    // Palette: Deep blue/black (dark) → Purple (dim) → Yellow → White (bright lights)
    // Contextual meaning: Like viewing city at night - dark sky to bright city lights
    // ═══════════════════════════════════════════════════════════════════════
    nightlights: {
      min: 0,
      max: 60,
      palette: ['#0D1B2A', '#1B263B', '#415A77', '#778DA9', '#B8A989', '#E0BB7F', '#F4D58D', '#FFFACD'],
      unit: 'nW/cm²/sr'
    },

    // ═══════════════════════════════════════════════════════════════════════
    // IMPERVIOUSNESS: Natural ground to concrete
    // Purpose: Show impervious surface coverage (roads, buildings, parking lots)
    // Palette: Light green (permeable, natural) → Gray (concrete, impermeable)
    // Contextual meaning: Green = rainwater can soak in; Gray = runoff/flooding risk
    // ═══════════════════════════════════════════════════════════════════════
    imperv: {
      min: 0,
      max: 100,
      palette: ['#E8F5E9', '#C8E6C9', '#A5D6A7', '#81C784', '#78909C', '#546E7A', '#37474F'],
      unit: '%'
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ALBEDO (SURFACE REFLECTANCE): Dark to bright surfaces
    // Purpose: Show how reflective surfaces are (dark absorbs heat, bright reflects it)
    // Palette: Black/dark brown (low albedo, hot) → Gray → White (high albedo, cool)
    // Contextual meaning: Dark surfaces get hotter; bright surfaces stay cooler
    // ═══════════════════════════════════════════════════════════════════════
    // ALBEDO: Surface reflectance (dark surfaces absorb heat, bright reflect)
    // Purpose: Identify dark roofs/pavements for cool coating programs
    // Palette: Dark brown (low albedo, absorbs heat) → Light tan/beige (high albedo, reflects heat)
    // Contextual meaning: Dark = heat absorption, Light = heat reflection
    // Range: 0.1-0.6 covers realistic urban surface range (dark asphalt to cool roofs)
    // ═══════════════════════════════════════════════════════════════════════
    albedo: {
      min: 0.1,
      max: 0.6,
      // Discrete color palette: Each color represents 0.05 albedo increment
      // 0.10-0.15: Very dark (black/dark brown) - fresh asphalt, dark roofs
      // 0.15-0.20: Dark brown - aged asphalt
      // 0.20-0.25: Brown - weathered concrete, dark surfaces
      // 0.25-0.30: Tan - aged concrete, mixed surfaces
      // 0.30-0.35: Light tan - lighter concrete
      // 0.35-0.40: Beige - bright surfaces, some vegetation
      // 0.40-0.45: Light beige - reflective materials
      // 0.45-0.50: Cream - highly reflective surfaces
      // 0.50-0.55: Light gray - cool roof coatings
      // 0.55-0.60: Near white - white roofs, maximum reflectivity
      palette: [
        '#000000',  // 0.10-0.15: Black (very dark asphalt)
        '#2d1b13',  // 0.15-0.20: Dark brown (aged asphalt)
        '#4e342e',  // 0.20-0.25: Brown (weathered concrete)
        '#6d4c41',  // 0.25-0.30: Medium brown (aged concrete)
        '#8d6e63',  // 0.30-0.35: Tan (lighter surfaces)
        '#a1887f',  // 0.35-0.40: Light tan (bright concrete)
        '#bcaaa4',  // 0.40-0.45: Beige (reflective materials)
        '#d7ccc8',  // 0.45-0.50: Light beige (very reflective)
        '#e8dfdc',  // 0.50-0.55: Cream (cool roofs)
        '#f3efed',  // 0.55-0.60: Light gray (near-white roofs)
        '#ffffff'   // 0.60+: White (maximum reflectivity)
      ],
      unit: 'surface albedo (0 = fully dark, 1 = fully reflective)',
      customLabels: {min: '0.1 (dark)', max: '0.6 (bright)'}
    },

    // ═══════════════════════════════════════════════════════════════════════
    // POPULATION DENSITY: Demographic intensity
    // Purpose: Show population density (people per area)
    // Palette: Very light blue (sparse) → Deep blue/purple (dense urban core)
    // Contextual meaning: Deeper colors = more people = higher service needs
    // ═══════════════════════════════════════════════════════════════════════
    population: {
      min: 0,
      max: 300,
      palette: [
        '#F1F8FF', '#DCEEFB', '#C5E4F3', '#A2D4EC', '#7BCAE1',
        '#5ABED6', '#42A5C8', '#2A8EB8', '#1A73A3', '#0D5B8A'
      ],
      unit: 'people per 100 m grid cell (1 hectare), log scale',
      logScale: true,
      // Labels must be truthful about POSITION on the log bar: the mid label
      // renders at the bar's centre (scaled=150 = 10^1.5 ≈ 30 people), so it
      // says ~30, NOT 100 (100 sits at the 2/3 mark, where no label renders).
      // Values >= 1,000 saturate the darkest colour, hence '1,000+'.
      customLabels: {
        min: '1',        // log10=0, scaled=0   (left edge)
        mid: '~30',      // log10=1.5, scaled=150 (true centre value)
        max: '1,000+'    // log10=3, scaled=300 (right edge; saturates above)
      }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // BUILT-UP PROBABILITY (Dynamic World): Development confidence
    // Purpose: Show probability that area is built-up/developed (0-1 scale)
    // Palette: Light gray (low confidence) → Dark purple (high confidence)
    // Contextual meaning: Shows gradual transitions and settlement density
    // ═══════════════════════════════════════════════════════════════════════
    builtProb: {
      min: 0,
      max: 1,
      palette: ['#f7f7f7', '#d9d9d9', '#bdbdbd', '#969696', '#737373', '#525252', '#252525', '#4a148c', '#6a1b9a'],
      unit: 'built-up probability (%)',
      customLabels: {min: '0%', mid: '50%', max: '100%'}
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SETTLEMENT TEXTURE: COMMENTED OUT (Not needed for Varanasi dashboard)
    // ═══════════════════════════════════════════════════════════════════════
  }
};

// ───────────────────────────────────────────────────────────────────────────────
// 3. ERROR HANDLING UTILITIES

function getNumber(feature, prop, defaultVal) {
  return ee.Number(
    ee.Algorithms.If(
      ee.Algorithms.IsEqual(feature.get(prop), null),
      defaultVal,
      feature.get(prop)
    )
  );
}

function safeDictNumber(dict, key, defaultVal) {
  dict = ee.Dictionary(dict);
  var v = dict.get(key, defaultVal);
  // Handle null values from percentile reducers on masked/empty columns
  return ee.Number(ee.Algorithms.If(ee.Algorithms.IsEqual(v, null), defaultVal, v));
}

// Null-safe dictionary getter for percentile results
function safeDictNumberNull(dict, key, defaultVal) {
  dict = ee.Dictionary(dict);
  var v = dict.get(key);
  return ee.Number(ee.Algorithms.If(ee.Algorithms.IsEqual(v, null), defaultVal, v));
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISPLAY CONVENTION (used by every panel, legend and export definition)
//   Counts & people : Indian digit grouping - 12,34,567 (formatIndianCount)
//   Money           : '₹' + lakh / crore words, 1 decimal; grouped rupees
//                     below 1 lakh (formatRupees / formatRupeeRange). Never 'Rs',
//                     never 'K', never 'Cr'.
//   Area            : hectares for intervention areas (whole ha from 10 ha up,
//                     1 decimal below - formatHa); km² (1 decimal) for ward and
//                     city areas; 'm²' only for per-building sizes and ₹/m² rates
//   Temperature     : 1 decimal + '°C' with no space ('41.2°C')
//   Percent         : whole number + '%'
//   Scores          : whole number out of 100
// ═══════════════════════════════════════════════════════════════════════════════
function formatIndianCount(num, decimals) {
  var n = Number(num);
  if (!isFinite(n)) return '0';
  var d = (decimals === undefined || decimals === null) ? 0 : decimals;
  var neg = n < 0;
  var parts = Math.abs(n).toFixed(d).split('.');
  var intPart = parts[0];
  var last3 = intPart.slice(-3);
  var rest = intPart.slice(0, -3);
  if (rest) last3 = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  return (neg ? '-' : '') + last3 + (parts[1] ? '.' + parts[1] : '');
}

// Large quantities in lakh / crore words ('2.5 lakh', '1.2 crore'); below one
// lakh the plain Indian-grouped figure
function formatIndianNumber(num, decimals) {
  var n = Number(num) || 0;
  var d = (decimals === undefined || decimals === null) ? 1 : decimals;
  if (Math.abs(n) >= 10000000) return (n / 10000000).toFixed(d) + ' crore';
  if (Math.abs(n) >= 100000) return (n / 100000).toFixed(d) + ' lakh';
  return formatIndianCount(n, 0);
}

function formatRupees(rupees, decimals) {
  return '₹' + formatIndianNumber(rupees, decimals);
}

// A money range in ONE unit for both ends: '₹1.2–1.8 crore', '₹45.0–69.0 lakh'
function formatRupeeRange(minRupees, maxRupees, decimals) {
  var d = (decimals === undefined || decimals === null) ? 1 : decimals;
  var hi = Math.max(Math.abs(Number(minRupees) || 0), Math.abs(Number(maxRupees) || 0));
  if (hi >= 10000000) {
    return '₹' + (minRupees / 10000000).toFixed(d) + '–' + (maxRupees / 10000000).toFixed(d) + ' crore';
  }
  if (hi >= 100000) {
    return '₹' + (minRupees / 100000).toFixed(d) + '–' + (maxRupees / 100000).toFixed(d) + ' lakh';
  }
  return '₹' + formatIndianCount(minRupees, 0) + '–' + formatIndianCount(maxRupees, 0);
}

// Hectares: whole ha once the figure is 10 ha or more, one decimal below
function formatHa(ha) {
  var n = Number(ha) || 0;
  return n >= 10 ? formatIndianCount(Math.round(n), 0) : n.toFixed(1);
}

function getFirstStringProp(f, names, defaultVal) {
  var init = ee.String(ee.Algorithms.If(
    ee.Algorithms.IsEqual(defaultVal, null),
    '',
    defaultVal
  ));

  // Walk the names in order and keep the first non-null, non-empty value.
  // The accumulator starts EMPTY (not at the default) so a later name can
  // never overwrite an earlier hit; the default is applied only at the end.
  var result = ee.List(names).iterate(function(n, acc) {
    acc = ee.String(acc);
    var v = f.get(ee.String(n));
    return ee.Algorithms.If(
      acc.length().gt(0),
      acc,  // already found an earlier name
      ee.Algorithms.If(ee.Algorithms.IsEqual(v, null), acc, ee.String(v))
    );
  }, ee.String(''));
  result = ee.String(result);
  return ee.String(ee.Algorithms.If(result.length().gt(0), result, init));
}

function ensureRange(value, min, max) {
  return ee.Number(value).max(min).min(max);
}


// === PRIORITY-BASED FUNCTIONS ===
// ───────────────────────────────────────────────────────────────────────────────
// 4. PRIORITY-BASED FUNCTIONS


function addPriorityByPercentiles(fc, prop, pMed, pHigh) {
  // CRITICAL FIX: Keep ALL wards (including nulls) to prevent holes in choropleth
  // Nulls will be assigned 'Low' priority instead of being dropped
  var fcAll = ee.FeatureCollection(fc);
  var fcValid = fcAll.filter(ee.Filter.notNull([prop]));

  // Calculate percentiles only from valid (non-null) wards
  var n = fcValid.size();

  // Force stable output keys so we NEVER depend on EE's default names
  var reducer = ee.Reducer.percentile([pMed, pHigh]).setOutputs(['pMed', 'pHigh']);
  var pctDict = ee.Dictionary(fcValid.reduceColumns(reducer, [prop]));

  var tMed  = safeDictNumber(pctDict, 'pMed', 0);
  var tHigh = safeDictNumber(pctDict, 'pHigh', 0);

  // Map ALL wards (not just valid ones) to prevent holes
  return fcAll.map(function(f) {
    var v = ee.Number(f.get(prop));
    var isNull = ee.Algorithms.IsEqual(v, null);

    // If value is null, assign 'Low' priority (prevents holes in visualization)
    var level = ee.Algorithms.If(
      isNull,
      'Low',  // Null wards get Low priority
      ee.Algorithms.If(
        v.gte(tHigh), 'High',
        ee.Algorithms.If(v.gte(tMed), 'Medium', 'Low')
      )
    );

    // Use 0 for null scores
    var score = ee.Algorithms.If(isNull, 0, v);

    return f.set({
      priority_level: level,
      priority_score: score,
      _tMed: tMed,
      _tHigh: tHigh
    });
  });
}

// ========================================
// IPCC HEAT RISK INDEX - HELPER FUNCTIONS
// ========================================

/**
 * Normalize a value to 0-1 using city percentile bounds (p5-p95)
 * @param {ee.Number} value - The value to normalize
 * @param {ee.Number} p5 - 5th percentile (lower bound)
 * @param {ee.Number} p95 - 95th percentile (upper bound)
 * @returns {ee.Number} - Normalized value clamped to [0, 1]
 */
function normalizeByPercentiles(value, p5, p95) {
  var range = ee.Number(p95).subtract(ee.Number(p5)).max(0.01); // Avoid division by zero
  var normalized = ee.Number(value).subtract(ee.Number(p5)).divide(range);
  return normalized.clamp(0, 1);
}

/**
 * Join ward results using ee.Join.saveFirst() for performance
 * Avoids O(n²) .filterMetadata().first() pattern
 * @param {ee.FeatureCollection} baseWards - Base ward boundaries
 * @param {ee.FeatureCollection} resultsFC - Results to join
 * @param {string} joinKey - Property name to join on (e.g., 'WARD_NO')
 * @param {string} prefix - Prefix for matched properties
 * @returns {ee.FeatureCollection} - Joined wards with new properties
 */
function joinWardResults(baseWards, resultsFC, joinKey, prefix) {

  try {
    var filter = ee.Filter.equals({
      leftField: joinKey,
      rightField: joinKey
    });

    var join = ee.Join.saveFirst({
      matchKey: prefix,
      outer: true
    });

    var joined = join.apply(baseWards, resultsFC, filter);


    var result = joined.map(function(feature) {
      feature = ee.Feature(feature);
      var matched = feature.get(prefix);

      // Get matched feature's properties as dictionary (or empty if null)
      var matchedDict = ee.Algorithms.If(
        ee.Algorithms.IsEqual(matched, null),
        ee.Dictionary(),
        ee.Feature(matched).toDictionary()
      );

      // Combine properties: original + matched (matched overwrites if conflict)
      // Remove the prefix property to avoid storing nested Feature objects
      var combinedProps = feature.toDictionary()
        .combine(ee.Dictionary(matchedDict), true)
        .remove([prefix]);

      // Return new feature with combined properties
      return ee.Feature(feature.geometry(), combinedProps);
    });

    // Debug: Check first feature's properties after join
    if (DEBUG_MODE) {
      result.limit(1).evaluate(function(fc) {
        if (fc && fc.features && fc.features[0]) {
        }
      });
    }

    return result;

  } catch (e) {
    throw e;
  }
}

// Selective property joining function - only copies specified properties to reduce memory usage
// This is more memory-efficient than copying all properties via toDictionary()
function joinWardResultsSelective(baseWards, resultsFC, joinKey, properties) {

  try {
    baseWards = ee.FeatureCollection(baseWards);
    resultsFC = ee.FeatureCollection(resultsFC);

    var filter = ee.Filter.equals({
      leftField: joinKey,
      rightField: joinKey
    });

    var join = ee.Join.saveFirst({
      matchKey: '_matched',
      outer: true
    });

    var joined = join.apply(baseWards, resultsFC, filter);


    var result = joined.map(function(feature) {
      feature = ee.Feature(feature);
      var matched = feature.get('_matched');

      // Build dictionary of selected properties using toDictionary (null-tolerant)
      // toDictionary silently omits null/absent properties so downstream defaults apply
      var propsDict = ee.Dictionary(ee.Algorithms.If(
        ee.Algorithms.IsEqual(matched, null),
        ee.Dictionary({}),
        ee.Feature(matched).toDictionary(properties)  // null-tolerant, drops null props
      ));

      // Combine properties and remove _matched (use remove, not set to null)
      var combinedProps = feature.toDictionary()
        .combine(propsDict, true)
        .remove(['_matched']);

      // Return new feature with combined properties
      return ee.Feature(feature.geometry(), combinedProps);
    });

    // Debug: Check first feature's properties after selective join
    if (DEBUG_MODE) {
      result.limit(1).evaluate(function(fc) {
        if (fc && fc.features && fc.features[0]) {
        }
      });
    }

    return result;

  } catch (e) {
    throw e;
  }
}

// Percentile-based priority classification that KEEPS ALL WARDS (no null dropping)
// Optimized version with reduced memory usage and single-pass classification
function addPriorityByPercentilesKeepAll(fc, prop, pMed, pHigh) {
  fc = ee.FeatureCollection(fc);

  var valid = fc.filter(ee.Filter.notNull([prop]));
  var n = valid.size();

  var reducer = ee.Reducer.percentile([pMed, pHigh]).setOutputs(['pMed', 'pHigh']);
  var pctDict = ee.Dictionary(valid.reduceColumns(reducer, [prop]));

  var tMed  = safeDictNumber(pctDict, 'pMed', 0);
  var tHigh = safeDictNumber(pctDict, 'pHigh', 0);

  // Optimized: Single conditional map instead of nested If statements
  // Also removed _tMed and _tHigh storage if not used downstream
  return ee.FeatureCollection(ee.Algorithms.If(
    n.eq(0),
    fc.map(function(f){
      return f.set({priority_level:'Low', priority_score:0});
    }),
    fc.map(function(f) {
      // Null-safe: ee.Number(null).max(0) fails server-side ("Parameter
      // 'left' is required") and takes the whole collection down. Null
      // scores become 0, which the thresholds then classify as Low.
      var raw = f.get(prop);
      var v = ee.Number(ee.Algorithms.If(
        ee.Algorithms.IsEqual(raw, null), 0, raw
      )).max(0);

      // More efficient level determination with single conditional chain
      var level = ee.String(
        ee.Algorithms.If(v.gte(tHigh), 'High',
          ee.Algorithms.If(v.gte(tMed), 'Medium', 'Low'))
      );

      return f.set({
        priority_level: level,
        priority_score: v
        // Removed _tMed and _tHigh unless needed downstream
      });
    })
  ));
}

// Cumulative share classification: High = wards containing top X% of exposed people
// This is MORE ALIGNED with "protect the most people" objective than percentile
// FIXED: Cast to FeatureCollection AFTER ee.Algorithms.If (iterate returns List)

// Population exposure priority: ORIGINAL SIMPLE VERSION
// Fixed % thresholds: Low < 25%, Medium 25-60%, High > 60%
// ───────────────────────────────────────────────────────────────────────────────
// CHOROPLETH VISUALIZATION FUNCTIONS
// Creates smooth ward-level visualizations with continuous color scales
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Creates a smooth choropleth visualization from ward-level continuous data
 * @param {ee.FeatureCollection} fc - Ward feature collection with property values
 * @param {string} property - Property name to visualize (e.g., 'popHeatScore')
 * @param {number} scale - Spatial resolution for painting (default: 60m for smooth appearance)
 * @returns {ee.Image} Painted image ready for visualization
 */
function paintWardChoropleth(fc, property, scale) {
  if (!fc) return ee.Image(0);

  if (DEBUG_MODE) {
    // Check first feature for the property
    fc.limit(1).evaluate(function(result) {
      if (result && result.features && result.features[0]) {
        var props = result.features[0].properties;
        if (props[property] === null || props[property] === undefined) {
        }
      }
    });
  }

  // Filter out features where the property is null/undefined
  var filtered = fc.filter(ee.Filter.notNull([property]));

  // Paint wards with continuous property values
  // Higher resolution (60m) creates smoother ward fills than pixel-level detail
  return ee.Image().float().paint({
    featureCollection: filtered,
    color: property
  }).reproject({
    crs: 'EPSG:4326',
    scale: scale || 60
  });
}

/**
 * Legacy function for 3-category priority visualization (Low/Medium/High)
 * Use paintWardChoropleth() for continuous data instead
 */
function paintPriority(fc, layerName) {
  if (!fc) {
    return ee.Image(0);
  }

  if (DEBUG_MODE) {
    // Check first feature for priority_level
    fc.limit(1).evaluate(function(result) {
      if (result && result.features && result.features[0]) {
        var props = result.features[0].properties;
        if (!props.priority_level) {
        }
      } else {
      }
    });
  }

  var lut = ee.Dictionary({'Low': 1, 'Medium': 2, 'High': 3});
  var coded = fc.map(function(f) {
    f = ee.Feature(f);
    var level = f.get('priority_level');

    // Check if level is null or undefined - default to Medium (2)
    var isNull = ee.Algorithms.IsEqual(level, null);

    var code = ee.Number(ee.Algorithms.If(
      isNull,
      2,  // Default to Medium if priority_level is missing
      lut.get(level, 2)  // Get code from lookup, default to 2 if not found
    ));

    return f.set('prio_code', code);
  });

  return ee.Image().byte().paint({
    featureCollection: coded,
    color: 'prio_code'
  }).reproject({
    crs: 'EPSG:4326',
    scale: 60  // ✅ CRITICAL: Explicit scale prevents 1m default (50-100x speedup)
  });
}

/**
 * Generic ward property painter (used for Overall Vulnerability)
 */
function createDefaultWardResults(wardsCollection) {
  if (!wardsCollection) {
    return ee.FeatureCollection([]);
  }

  return wardsCollection.map(function(ward) {
    var wardId = ee.Number(ward.get('WARD_NO'));
    var seed = wardId.multiply(13).mod(100);

    return ward.set({
      'WARD_NO': wardId,
      'priority_level': 'Low',  // Default fallback shows as green, not Medium yellow
      'LST_mean': seed.multiply(0.08).add(38),
      'LST_max': seed.multiply(0.1).add(42),
      'LST_p90': seed.multiply(0.09).add(40),
      'heat_score': seed.multiply(0.4).add(30),
      // All-land SUHI (includes parks, vegetation, built areas)
      'UHI_all_mean': seed.multiply(0.1).add(5),
      'UHI_all_p90': seed.multiply(0.15).add(7),
      // Built-only SUHI (roads, roofs, pavements)
      'UHI_built_mean': seed.multiply(0.12).add(6),
      'UHI_built_p90': seed.multiply(0.18).add(8),
      'totalPop': wardId.multiply(1000).add(4000),
      'popHighRisk': wardId.multiply(300).add(800),      // Compound exposure
      'popMediumRisk': wardId.multiply(400).add(1000),   // Single stressor
      'popAtRisk': wardId.multiply(700).add(1800),       // Total exposed
      'avgHeat': seed.multiply(0.08).add(38),
      'pctPopHighRisk': seed.multiply(0.25).add(20),     // % in compound risk
      'pctPopAtRisk': seed.multiply(0.4).add(40),        // % in any risk
      'popHeatScore': seed.multiply(0.35).add(35),
      'coolRoofPriorityScore': seed.multiply(0.45).add(25),
      'farFromCoolingPct': seed.multiply(0.4).add(30),
      'greenAccessScore': seed.multiply(0.5).add(20),
      'activityHeatScore': seed.multiply(0.4).add(30)
    });
  });
}

// ───────────────────────────────────────────────────────────────────────────────
// FIXED: WARD PRIORITY EXTRACTION - SHOWS ALL HIGH PRIORITY WARDS
// Shows ALL wards marked as 'High' priority (red on map)
// Falls back to top 5 by score only if NO high priority wards exist

function processWardPriorities(callback) {
  if (!wardResults) {
    if (callback) callback();
    return;
  }

  wardPriorities = {};

  // ─────────────────────────────────────────────────────────────────────────────
  // LAND SURFACE TEMPERATURE - Top 5 wards by mean LST
  // ─────────────────────────────────────────────────────────────────────────────
  if (wardResults.lstWards) {
    wardPriorities['Land Surface Temperature (Daytime, clear-sky)'] = wardResults.lstWards
      .map(function(f) {
        var score = getNumber(f, 'LST_mean', -999);
        var id = getNumber(f, 'WARD_NO', 0);
        return f.set('sortKey', score.multiply(1e6).add(id));
      })
      .sort('sortKey', false)
      .limit(5)
      .map(function(f) { return f.set('priority_level', 'Top'); });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SURFACE HEAT ANOMALY - Top 5 wards by UHI anomaly score (all land)
  // Uses all-land SUHI score (includes parks, vegetation, built areas)
  // ─────────────────────────────────────────────────────────────────────────────
  if (wardResults.lstWards) {
    wardPriorities['Surface Temperature Hotspots'] = wardResults.lstWards
      .map(function(f) {
        var score = getNumber(f, 'heat_score', -999);  // Fixed: Use heat_score (displayed value) instead of LST_hotspot
        var id = getNumber(f, 'WARD_NO', 0);
        return f.set('sortKey', score.multiply(1e6).add(id));
      })
      .sort('sortKey', false)
      .limit(5)
      .map(function(f) { return f.set('priority_level', 'Top'); });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // BUILT SURFACE HEAT - Top 5 wards by built-only SUHI score
  // ACTIONABLE for cool roof/pavement/shade interventions
  // Ignores parks — focuses only on roads, roofs, and built areas
  // ─────────────────────────────────────────────────────────────────────────────
  if (wardResults.lstWards) {
    wardPriorities['Built Surface Heat (Intervention Zones)'] = wardResults.lstWards
      .map(function(f) {
        var score = getNumber(f, 'uhi_built_score', -999);
        var id = getNumber(f, 'WARD_NO', 0);
        return f.set('sortKey', score.multiply(1e6).add(id));
      })
      .sort('sortKey', false)
      .limit(5)
      .map(function(f) { return f.set('priority_level', 'Top'); });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // POPULATION HEAT EXPOSURE PRIORITY - SHOW ALL HIGH WARDS
  // BEST PRACTICE: Rank by EXPOSED PEOPLE count (popAtRisk), not complex scores
  // ─────────────────────────────────────────────────────────────────────────────
  if (wardResults.popHeatWardsPriority) {
    // ALL high wards (sorted by RISK SCORE)
    var popHighAll = wardResults.popHeatWardsPriority
      .filter(ee.Filter.eq('priority_level', 'High'))
      .sort('riskScore', false);  // Sort by risk score

    var popHighCount = popHighAll.size();


    wardPriorities['Population Heat Risk'] = ee.FeatureCollection(
      ee.Algorithms.If(
        popHighCount.gt(0),
        popHighAll,  // ✅ show ALL red wards sorted by risk score
        wardResults.popHeatWardsPriority
          .sort('riskScore', false)  // Sort by risk score
          .limit(5)  // fallback only when no High exist
      )
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // COOL ROOF - Extract ALL wards with priority_level='High'
  // FALLBACK: If no 'High' wards exist, use top 5 by coolRoofPriorityScore
  // ─────────────────────────────────────────────────────────────────────────────
  if (wardResults.coolRoofWardsPriority) {
    var coolRoofHighPriority = wardResults.coolRoofWardsPriority
      .filter(ee.Filter.eq('priority_level', 'High'))
      .map(function(f) {
        var score = getNumber(f, 'coolRoofPriorityScore', -999);
        var id = getNumber(f, 'WARD_NO', 0);
        return f.set('sortKey', score.multiply(1e6).add(id));
      })
      .sort('sortKey', false);
    // REMOVED .limit(5) - show ALL high priority wards

    var coolRoofHighCount = coolRoofHighPriority.size();

    wardPriorities['Cool Roof Priority'] = ee.FeatureCollection(
      ee.Algorithms.If(
        coolRoofHighCount.gt(0),
        coolRoofHighPriority,  // ALL high priority wards
        wardResults.coolRoofWardsPriority
          .map(function(f) {
            var score = getNumber(f, 'coolRoofPriorityScore', -999);
            var id = getNumber(f, 'WARD_NO', 0);
            return f.set('sortKey', score.multiply(1e6).add(id));
          })
          .sort('sortKey', false)
          .limit(5)
      )
    );

  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TREE PLANTING PRIORITY - Extract ALL wards with priority_level='High' (red on map)
  // These are wards with canopy <20% (no built fraction threshold)
  // No fallback - if no High wards exist, panel will show explanatory message
  // ─────────────────────────────────────────────────────────────────────────────
  if (wardResults.canopyGapWardsPriority) {
    // Extract ALL wards with priority_level='High' (red on map)
    // These match exactly what's shown in red on the visualization
    var greenHighPriority = wardResults.canopyGapWardsPriority
      .filter(ee.Filter.eq('priority_level', 'High'))
      .map(function(f) {
        var score = getNumber(f, 'priority_score', -999);  // Sort by greening need (canopy deficit × built)
        var id = getNumber(f, 'WARD_NO', 0);
        return f.set('sortKey', score.multiply(1e6).add(id));
      })
      .sort('sortKey', false);  // Descending: highest greening need first

    var greenHighCount = greenHighPriority.size();

    // Store ALL High priority wards (no limit)
    // This matches exactly what's shown in RED on the map
    wardPriorities['Tree Planting Priority'] = greenHighPriority;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // NIGHTTIME ACTIVITY - Extract ALL wards with priority_level='High'
  // FALLBACK: If no 'High' wards exist, use top 5 by activityHeatScore
  // ─────────────────────────────────────────────────────────────────────────────
  if (wardResults.activityHeatWardsPriority) {
    var activityHighPriority = wardResults.activityHeatWardsPriority
      .filter(ee.Filter.eq('priority_level', 'High'))
      .map(function(f) {
        var score = getNumber(f, 'activityHeatScore', -999);
        var id = getNumber(f, 'WARD_NO', 0);
        return f.set('sortKey', score.multiply(1e6).add(id));
      })
      .sort('sortKey', false);
    // REMOVED .limit(5) - show ALL high priority wards

    var activityHighCount = activityHighPriority.size();

    wardPriorities['24-Hour Heat Zones'] = ee.FeatureCollection(
      ee.Algorithms.If(
        activityHighCount.gt(0),
        activityHighPriority,  // ALL high priority wards
        wardResults.activityHeatWardsPriority
          .map(function(f) {
            var score = getNumber(f, 'activityHeatScore', -999);
            var id = getNumber(f, 'WARD_NO', 0);
            return f.set('sortKey', score.multiply(1e6).add(id));
          })
          .sort('sortKey', false)
          .limit(5)
      )
    );

  }

  // ─────────────────────────────────────────────────────────────────────────────
  // INFORMAL HOUSING RISK - Extract ALL wards with priority_level='High'
  // FALLBACK: If no 'High' wards exist, use top 5 by informalHousingScore
  // ─────────────────────────────────────────────────────────────────────────────
  if (wardResults.informalHousingWardsPriority) {
    var informalHighPriority = wardResults.informalHousingWardsPriority
      .filter(ee.Filter.eq('priority_level', 'High'))
      .map(function(f) {
        var score = getNumber(f, 'informalHousingScore', -999);
        var id = getNumber(f, 'WARD_NO', 0);
        return f.set('sortKey', score.multiply(1e6).add(id));
      })
      .sort('sortKey', false);
    // REMOVED .limit(5) - show ALL high priority wards

    var informalHighCount = informalHighPriority.size();

    wardPriorities['Dense Vulnerable Housing'] = ee.FeatureCollection(
      ee.Algorithms.If(
        informalHighCount.gt(0),
        informalHighPriority,  // ALL high priority wards
        wardResults.informalHousingWardsPriority
          .map(function(f) {
            var score = getNumber(f, 'informalHousingScore', -999);
            var id = getNumber(f, 'WARD_NO', 0);
            return f.set('sortKey', score.multiply(1e6).add(id));
          })
          .sort('sortKey', false)
          .limit(5)
      )
    );

  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LAND USE - Not applicable for priority ranking
  // ─────────────────────────────────────────────────────────────────────────────
  wardPriorities['Land Use'] = null;

  // ─────────────────────────────────────────────────────────────────────────────
  // COMPOSITE HEAT RISK INDEX - All High priority wards
  // Replaces old "Overall Vulnerability" with scientifically defensible framework
  // ─────────────────────────────────────────────────────────────────────────────
  if (wardResults.heatRiskWards) {
    var riskHigh = wardResults.heatRiskWards.filter(ee.Filter.eq('priority_level', 'High'));
    var nHigh = riskHigh.size();

    wardPriorities['Composite Heat Risk'] = ee.FeatureCollection(ee.Algorithms.If(
      nHigh.gt(0),
      riskHigh,
      // Fallback: Top 5 by riskIndex if no High priority wards
      wardResults.heatRiskWards.sort('riskIndex', false).limit(5)
    ));
  }


  if (callback) callback();
}

// ───────────────────────────────────────────────────────────────────────────────
// 5. BOUNDARY LOADING

function loadBoundaries() {
  var cityConfig = cityConfigs[cityName];
  if (!cityConfig) {
    throw new Error('City configuration not found: ' + cityName);
  }

  // 1️⃣ Load wards EXACTLY as uploaded
  var wards = ee.FeatureCollection(cityConfig.assetPath);

  // 2️⃣ Standardize ward ID
  wards = wards.map(function(f) {
    var wardNoRaw = ee.Algorithms.If(
      f.propertyNames().contains('WARD_NO'), f.get('WARD_NO'),
      ee.Algorithms.If(
        f.propertyNames().contains('ward_no'), f.get('ward_no'),
        ee.Algorithms.If(
          f.propertyNames().contains('ward_lgd_c'), f.get('ward_lgd_c'),
          ee.Algorithms.If(
            f.propertyNames().contains('id'), f.get('id'),
            f.get('system:index')
          )
        )
      )
    );

    // Safe parsing with fallback for alphanumeric/hex system:index values
    var wardNoStr = ee.String(wardNoRaw);
    var hasDigits = wardNoStr.match('[0-9]+').length().gt(0);
    var wardNo = ee.Number(ee.Algorithms.If(
      hasDigits,
      // If contains digits, extract and parse first numeric sequence
      ee.Number.parse(wardNoStr.match('[0-9]+').get(0)),
      // Otherwise use 1-based sequential index as fallback
      ee.Number(wards.toList(10000).indexOf(f)).add(1)
    )).int();

    var wardName = getFirstStringProp(
      f,
      ['ward_name', 'WARD_NAME', 'ward_lgd_n', 'name', 'NAME'],
      ee.String('Ward ').cat(wardNo.format())
    );

    // ✅ FIX: Normalize Unicode dashes to standard ASCII hyphen
    wardName = ee.String(wardName)
      .replace('–', '-', 'g')  // en-dash (U+2013)
      .replace('—', '-', 'g')  // em-dash (U+2014)
      .replace('−', '-', 'g'); // minus sign (U+2212)

    return f.set({
      WARD_NO: wardNo,
      ward_name: wardName,
      city: cityName,
      state: cityStateMapping[cityName] || 'Unknown'
    });
  });

  return {
    wards: wards,
    config: cityConfig
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// 6. DATA PROCESSING HELPER FUNCTIONS

// CRITICAL FIX: Define stable 10-band schema for Landsat composites
// Landsat L2 has ~19 bands, but we only need these 10
var CORE_LANDSAT_BANDS = [
  'SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6', 'SR_B7',  // Reflectance
  'ST_B10',       // Surface temperature
  'QA_PIXEL',     // Quality flags
  'ST_QA'         // ST uncertainty
];

function applyScaleFactors(img) {
  if (!img) {
    return ee.Image.constant(0);
  }

  try {
    var scaled = img
      .addBands(img.select('SR_B.*').multiply(0.0000275).add(-0.2), null, true)
      .addBands(img.select('ST_B.*').multiply(0.00341802).add(149.0), null, true);
    return scaled;
  } catch (e) {
    return img;
  }
}

function maskClouds(img) {
  if (!img) {
    return ee.Image.constant(0);
  }

  try {
    var qa = img.select('QA_PIXEL');

    // Bits from EE Data Catalog (QA_PIXEL)
    var mask = qa.bitwiseAnd(1 << 0).eq(0)  // Fill
      .and(qa.bitwiseAnd(1 << 1).eq(0))     // Dilated Cloud
      .and(qa.bitwiseAnd(1 << 2).eq(0))     // Cirrus
      .and(qa.bitwiseAnd(1 << 3).eq(0))     // Cloud
      .and(qa.bitwiseAnd(1 << 4).eq(0))     // Cloud Shadow
      .and(qa.bitwiseAnd(1 << 5).eq(0));    // Snow

    // Check if optional bands exist before using them
    var bandNames = img.bandNames();
    var hasRadsat = bandNames.contains('QA_RADSAT');
    var hasCdist = bandNames.contains('ST_CDIST');

    // Optional: remove saturated pixels (if band exists)
    var sat = ee.Image.constant(1); // Default: no masking
    sat = ee.Algorithms.If(
      hasRadsat,
      img.select('QA_RADSAT').eq(0),
      sat
    );
    sat = ee.Image(sat);

    // ST_QA uncertainty filter: RELAXED for spatial completeness (≤ 5 K)
    // Rationale: This is relative prioritization (multi-year composite), not measurement-grade thermal study
    // Trading some precision for vastly better spatial coverage
    var stUncK = img.select('ST_QA').multiply(0.01);
    var stQualityMask = stUncK.lte(5);  // Relaxed from 2K to 5K

    // ST_CDIST cloud-adjacency buffer: RELAXED for spatial completeness (> 0.3 km)
    // Strict 1km threshold was excluding too many valid urban pixels
    // Median compositing across years handles remaining noise
    var cloudDistMask = ee.Image.constant(1); // Default: no masking
    cloudDistMask = ee.Algorithms.If(
      hasCdist,
      img.select('ST_CDIST').multiply(0.01).gt(0.3),  // Relaxed from 1.0 km to 0.3 km
      cloudDistMask
    );
    cloudDistMask = ee.Image(cloudDistMask);

    return img.updateMask(mask).updateMask(sat).updateMask(stQualityMask).updateMask(cloudDistMask);
  } catch (e) {
    return img;
  }
}


// Band-standardizing function: ensures all Landsat images have exactly 10 bands
// This prevents "Image.rename: number of names must match number of bands" errors
function prepLandsatForComposite(img) {
  img = applyScaleFactors(img);
  img = maskClouds(img);

  // IMPORTANT: select AFTER masking (maskClouds needs QA_RADSAT and ST_CDIST)
  // This reduces ~19 bands down to the 10 we actually need
  return img.select(CORE_LANDSAT_BANDS);
}

// ───────────────────────────────────────────────────────────────────────────────
// 7. CORE DATA PROCESSING FUNCTIONS

// ───────────────────────────────────────────────────────────────────────────────
// NEW FUNCTION: Load Sentinel-2 specifically for high-resolution albedo (10m)
// ───────────────────────────────────────────────────────────────────────────────
function loadSentinel2ForAlbedo(region, startDate, endDate, summerFilter) {
  try {
    var cacheKey = cityName + '_sentinel2_albedo_' + startDate + '_' + endDate;
    if (computeCache[cacheKey]) {
      return computeCache[cacheKey];
    }

    // ⚡ ASSET CACHE: load materialized 10m albedo instead of recomputing the
    // Sentinel-2 composite (see ASSET_CACHE block at top).
    if (cityIsPrecomputed(cityName)) {
      var cachedAlbedo = ee.Image(cacheAssetId(cityName, 'albedo'))
        .select('albedo')
        .clip(region);
      computeCache[cacheKey] = cachedAlbedo;
      return cachedAlbedo;
    }

    var bounds = region.bounds();

    // Load Sentinel-2 MSI - 10m RESOLUTION
    // Reference: Bonafoni & Sekertekin (2020) IEEE GRSL
    // Load Cloud Score+ for Sentinel-2 Harmonized
    // Reference: https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_CLOUD_SCORE_PLUS_V1_S2_HARMONIZED
    // NOTE: QA60 cloud bits were broken (all zeros) from ~Feb 2022 to Feb 2024,
    // which overlaps most of the analysis window. Cloud Score+ is the recommended
    // approach for reliable cloud/shadow/cirrus masking.
    var csPlus = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    var CS_BAND = 'cs_cdf';  // Calibrated clear-sky probability (0-1)
    var CLEAR_THRESHOLD = 0.60;  // 0.50-0.65 recommended; higher = stricter

    var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(bounds)
      .filter(summerFilter)
      .filterDate(startDate, endDate)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
      .linkCollection(csPlus, [CS_BAND])  // Link Cloud Score+ by system:index
      .map(function(img) {
        // Cloud Score+ masking - masks clouds, shadows, cirrus over bright surfaces
        // cs_cdf = 1 means clear, 0 means obscured
        var cloudMask = img.select(CS_BAND).gte(CLEAR_THRESHOLD);

        // Optional: Add SCL snow/ice masking (Cloud Score+ doesn't detect snow)
        var scl = img.select('SCL');
        var snowMask = scl.neq(11);  // Mask snow/ice (class 11)

        var combinedMask = cloudMask.and(snowMask);

        // Convert to [0, 1] reflectance - all six solar-spectrum bands
        var blue  = img.select('B2').divide(10000);   // 10m - Blue  (490 nm)
        var green = img.select('B3').divide(10000);   // 10m - Green (560 nm)
        var red   = img.select('B4').divide(10000);   // 10m - Red   (665 nm)
        var nir   = img.select('B8').divide(10000);   // 10m - NIR   (842 nm)

        // SWIR bands (native 20m) - resample to 10m with bilinear interpolation
        var swir1_10m = img.select('B11').resample('bilinear').reproject({
          crs: img.select('B2').projection(),
          scale: 10
        }).divide(10000);                              // SWIR1 (1610 nm)

        var swir2_10m = img.select('B12').resample('bilinear').reproject({
          crs: img.select('B2').projection(),
          scale: 10
        }).divide(10000);                              // SWIR2 (2190 nm)

        // BROADBAND ALBEDO at 10m resolution
        // Bonafoni & Sekertekin (2020) S2-native narrow-to-broadband coefficients
        // doi:10.1109/LGRS.2020.2967085 - urban-validated, all 6 bands, no intercept
        var albedo = blue.multiply(0.2266)             // B2 - Blue
          .add(green.multiply(0.1236))                 // B3 - Green
          .add(red.multiply(0.1573))                   // B4 - Red
          .add(nir.multiply(0.3417))                   // B8 - NIR
          .add(swir1_10m.multiply(0.1170))             // B11 - SWIR1
          .add(swir2_10m.multiply(0.0338))             // B12 - SWIR2
          .clamp(0, 1)
          .rename('albedo')
          .setDefaultProjection(ee.Projection('EPSG:4326').atScale(10));

        return albedo.updateMask(combinedMask);
      });

    // Calculate median composite of per-scene albedo
    var albedoComposite = ee.Image(ee.Algorithms.If(
      s2.size().gt(0),
      s2.median(),
      // ⚠️  FALLBACK: Using constant 0.15 albedo (NO SENTINEL-2 DATA AVAILABLE)
      // CRITICAL ISSUE: Albedo threshold for dark surfaces is <0.20
      // If constant 0.15 is used, ALL built pixels classify as dark
      // This inflates cool-roof area and cost estimates to full built footprint
      // User will see NO WARNING unless they check console
      ee.Image.constant(0.15).rename('albedo')
    )).clip(region).setDefaultProjection(ee.Projection('EPSG:4326').atScale(10));

    // Warn user if fallback was used
    s2.size().evaluate(function(count) {
      if (count === 0) {
        print('⚠️  WARNING: Albedo fallback active (constant 0.15) - Sentinel-2 data unavailable');
        print('⚠️  IMPACT: Cool roof estimates may be INFLATED (all built area classified as dark)');
        print('⚠️  Recommendation: Check date range or cloud cover thresholds');
      }
    });

    computeCache[cacheKey] = albedoComposite;
    return albedoComposite;

  } catch (e) {
    // Return fallback albedo with error warning
    print('❌ ERROR in loadAlbedoData: ' + e.message);
    print('⚠️  Using fallback albedo (constant 0.15) - cool roof estimates UNRELIABLE');
    return ee.Image.constant(0.15).rename('albedo').clip(region)
      .setDefaultProjection(ee.Projection('EPSG:4326').atScale(10));
  }
}

function loadLandsatData(region, startDate, endDate, summerFilter) {

  // ✅ FIRST THING: Print that function was called

  try {
    var cacheKey = cityName + '_' + startDate + '_' + endDate + '_landsat';
    var isCached = computeCache[cacheKey] !== undefined;


    if (isCached) {
      return computeCache[cacheKey];
    }

    // ⚡ ASSET CACHE: load the materialized composite instead of rebuilding the
    // 3-year median from scratch. Same pixels; every downstream reduction and
    // tile request skips the entire collection/mask/median graph.
    if (cityIsPrecomputed(cityName)) {
      var cachedComp = ee.Image(cacheAssetId(cityName, 'landsat_composite'))
        .select(CORE_LANDSAT_BANDS)
        .clip(region);
      computeCache[cacheKey] = cachedComp;
      return cachedComp;
    }



    var bounds = region.bounds();

    // 10-band fallback that MATCHES the composite band list exactly
    var defaultImage = ee.Image.constant([
      0.2, 0.2, 0.3, 0.4, 0.3, 0.2, 0.15,  // SR_B1..SR_B7
      300,                                  // ST_B10 (Kelvin placeholder)
      0,                                    // QA_PIXEL
      0                                     // ST_QA
    ]).rename(CORE_LANDSAT_BANDS).clip(region);

    // ═══════════════════════════════════════════════════════════════════════════════
    // SENTINEL-2 MSI - 10m RESOLUTION (HIGHEST AVAILABLE)
    // COPERNICUS/S2_SR_HARMONIZED - Harmonized Surface Reflectance
    // Reference: Bonafoni S., Sekertekin A. (2020). "Albedo Retrieval from Sentinel-2
    // by New Narrow-to-Broadband Conversion Coefficients." IEEE GRSL, 17(9), 1618-1622.
    // doi:10.1109/LGRS.2020.2967085
    // ═══════════════════════════════════════════════════════════════════════════════

    // Load Cloud Score+ for Sentinel-2 Harmonized
    // QA60 was non-functional Feb 2022 - Feb 2024; Cloud Score+ is the reliable alternative
    var csPlus = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
    var CS_BAND = 'cs_cdf';
    var CLEAR_THRESHOLD = 0.60;

    var s2 = ee.ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(bounds)
      .filter(summerFilter)
      .filterDate(startDate, endDate)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 30))
      .linkCollection(csPlus, [CS_BAND])
      .map(function(img) {
        // Cloud Score+ masking (replaces broken QA60 + SCL)
        var cloudMask = img.select(CS_BAND).gte(CLEAR_THRESHOLD);

        // Optional: SCL snow/ice masking
        var scl = img.select('SCL');
        var snowMask = scl.neq(11);  // Snow/ice

        var combinedMask = cloudMask.and(snowMask);

        // S2 SR bands are in range [0, 10000] representing reflectance * 10000
        // Convert to [0, 1] reflectance by dividing by 10000
        var blue = img.select('B2').divide(10000);    // 10m - Blue
        var green = img.select('B3').divide(10000);   // 10m - Green
        var red = img.select('B4').divide(10000);     // 10m - Red
        var nir = img.select('B8').divide(10000);     // 10m - NIR

        // SWIR bands (B11, B12) are native 20m - explicitly resample to 10m using bilinear
        // Bilinear interpolation preserves reflectance gradients better than nearest-neighbor
        var swir1_10m = img.select('B11').resample('bilinear').reproject({
          crs: img.select('B2').projection(),
          scale: 10
        });
        var swir2_10m = img.select('B12').resample('bilinear').reproject({
          crs: img.select('B2').projection(),
          scale: 10
        });
        var swir1 = swir1_10m.divide(10000);  // Now at 10m - SWIR1
        var swir2 = swir2_10m.divide(10000);  // Now at 10m - SWIR2

        // BROADBAND ALBEDO (10m)
        // Bonafoni & Sekertekin (2020) S2-native coefficients
        // doi:10.1109/LGRS.2020.2967085
        var albedo = blue.multiply(0.2266)             // B2 - Blue
          .add(green.multiply(0.1236))                 // B3 - Green
          .add(red.multiply(0.1573))                   // B4 - Red
          .add(nir.multiply(0.3417))                   // B8 - NIR
          .add(swir1.multiply(0.1170))                 // B11 - SWIR1 (10m resampled)
          .add(swir2.multiply(0.0338))                 // B12 - SWIR2 (10m resampled)
          .clamp(0, 1)
          .rename('albedo');

        // Map S2 bands to Landsat band names for compatibility
        // Keep in [0,1] range - downstream code will handle properly
        var mapped = ee.Image.cat([
          blue.rename('SR_B2'),
          green.rename('SR_B3'),
          red.rename('SR_B4'),
          nir.rename('SR_B5'),
          swir1.rename('SR_B6'),
          swir2.rename('SR_B7'),
          blue.rename('SR_B1'),                 // Coastal aerosol (placeholder)
          ee.Image.constant(300).updateMask(ee.Image.constant(0)).rename('ST_B10'), // ✅ FIX: Masked thermal placeholder (S2 has no thermal sensor)
          ee.Image.constant(0).rename('QA_PIXEL'),  // ✅ FIX: Constant placeholder (masking handled by Cloud Score+)
          ee.Image.constant(0).rename('ST_QA')
        ]).addBands(albedo);

        return mapped.updateMask(combinedMask);
      });

    var s2Count = s2.size();

    // ═══════════════════════════════════════════════════════════════════════════════
    // LANDSAT 8/9 COLLECTION 2 TIER 1 L2 - NATIVE THERMAL DATA
    // Use this for reliable thermal data instead of HLS (which has issues with B10)
    // ═══════════════════════════════════════════════════════════════════════════════

    // First check raw Landsat availability
    var landsatRaw = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
      .merge(ee.ImageCollection('LANDSAT/LC09/C02/T1_L2'))
      .filterBounds(bounds)
      .filterDate(startDate, endDate);

    // Apply filters progressively
    var landsat = landsatRaw
      .filter(summerFilter)
      .filter(ee.Filter.lt('CLOUD_COVER', 80))  // ✅ RELAXED: 50% → 80%
      .map(prepLandsatForComposite);  // Use existing prep function

    var landsatCount = landsat.size();

    // ✅ DEBUG: Log which data source is being used
    if (DEBUG_MODE) {
      s2Count.evaluate(function(s2) {
        landsatCount.evaluate(function(ls) {
          if (ls > 0) {
          } else if (s2 > 0) {
          } else {
          }
        });
      });
    }

    // Fallback to HLS if no Landsat data (though HLS thermal is problematic)
    var hls = ee.ImageCollection('NASA/HLS/HLSL30/v002')
      .filterBounds(bounds)
      .filter(summerFilter)
      .filterDate(startDate, endDate)
      .filter(ee.Filter.lt('CLOUD_COVERAGE', 30))  // ✅ RELAXED: 10% → 30%
      .map(function(img) {
        // ❌ REMOVED: .evaluate() calls inside .map() cause "client-side operations" error
        // Can't use .evaluate() inside a server-side .map() function!

        var fmask = img.select('Fmask');
        var cloudMask = fmask.bitwiseAnd(1 << 1).eq(0)
          .and(fmask.bitwiseAnd(1 << 3).eq(0));

        // BROADBAND ALBEDO - Liang (2001), correct OLI band mapping
        // albedo = 0.356*blue + 0.130*red + 0.373*NIR + 0.085*SWIR1 + 0.072*SWIR2 - 0.0018
        var albedo = img.select('B2').multiply(0.356)  // Blue
          .add(img.select('B4').multiply(0.130))       // Red
          .add(img.select('B5').multiply(0.373))       // NIR
          .add(img.select('B6').multiply(0.085))       // SWIR1
          .add(img.select('B7').multiply(0.072))       // SWIR2
          .subtract(0.0018)
          .clamp(0, 1)
          .rename('albedo');

        // ⚠️  WARNING: HLS L30 thermal band scaling and product type
        // HLS L30 B10 is TOA Brightness Temperature (BT), NOT surface temperature
        // Per HLS v2.0 spec, L30 does NOT include surface temperature product
        // Data stored as BT in Kelvin × 100 (DN format)
        // Scale factor: DN × 0.01 = Brightness Temperature (Kelvin)
        // Valid range: typically 27000-32000 DN ≈ 270-320 K ≈ -3°C to 47°C
        //
        // KNOWN ISSUE: If scaled product is in Celsius (not Kelvin), the downstream
        // subtract(273.15) produces ~−240°C, which the 10–80°C mask discards,
        // silently emptying LST when HLS fallback is active.
        //
        // Reference: HLS v2.0 User Guide - L30 thermal is BT, not ST
        var thermalKelvin = img.select('B10').multiply(0.01);  // HLS L30: DN(K×100) → Kelvin BT

        var mapped = ee.Image.cat([
          img.select('B1').rename('SR_B1'),
          img.select('B2').rename('SR_B2'),
          img.select('B3').rename('SR_B3'),
          img.select('B4').rename('SR_B4'),
          img.select('B5').rename('SR_B5'),
          img.select('B6').rename('SR_B6'),
          img.select('B7').rename('SR_B7'),
          thermalKelvin.rename('ST_B10'),  // Already in Kelvin, just rename
          fmask.rename('QA_PIXEL'),
          ee.Image.constant(0).rename('ST_QA')
        ]).addBands(albedo);

        return mapped.updateMask(cloudMask);
      });

    var hlsCount = hls.size();

    // ✅ FIXED PRIORITY with explicit thermal quality notes:
    // 1. Landsat Collection 2 L2 (BEST): ST_B10 atmosphere-corrected surface temperature
    // 2. HLS L30 (LOWER QUALITY): B10 TOA brightness temperature (NOT surface temp)
    // 3. Sentinel-2 (NO THERMAL): Using placeholder 300K constant
    //
    // IMPORTANT: Landsat ST vs HLS BT difference
    // - Landsat C2 L2 ST_B10: Atmospherically corrected surface temperature (recommended)
    // - HLS L30 B10: TOA brightness temperature only (no atmospheric correction)
    // - Difference can be 5-10K depending on atmospheric conditions
    var collection = ee.ImageCollection(ee.Algorithms.If(
      landsatCount.gt(0),
      landsat,  // BEST: Native Landsat thermal (30m, atmosphere-corrected ST)
      ee.Algorithms.If(
        hlsCount.gt(0),
        hls,    // FALLBACK: HLS L30 thermal (30m, TOA brightness temp only - NOT ST)
        s2      // LAST RESORT: S2 (no native thermal, using placeholder 300K constant)
      )
    ));

    // Median of per-scene albedo values
    var comp = ee.Image(ee.Algorithms.If(
      collection.size().gt(0),
      collection.median(),
      defaultImage
    ))
      .select(CORE_LANDSAT_BANDS)
      .clip(region);

    computeCache[cacheKey] = comp;
    return comp;

  } catch (e) {
    // ❌ ERROR CAUGHT - Print details

    // Absolute fallback
    var fallback = ee.Image.constant([
      0.2, 0.2, 0.3, 0.4, 0.3, 0.2, 0.15,
      300,
      0,
      0
    ]).rename(CORE_LANDSAT_BANDS).clip(region);

    computeCache[cacheKey] = fallback;
    return fallback;
  }
}

function calculateAirTempAndNDVI(composite, region, cityConfig) {
  try {
    var cacheKey = cityName + '_thermal';
    if (computeCache[cacheKey]) {
      return computeCache[cacheKey];
    }


    // Verify composite has required bands
    var bands = composite.bandNames();

    // 1. NDVI from scaled SR bands
    var ndvi = composite.normalizedDifference(['SR_B5', 'SR_B4'])
                        .rename('NDVI');

    // Create a robust land mask (water excluded)
    var waterClipped = water.clip(region);
    var landMask = waterClipped.lt(20)  // Less than 20% water occurrence = land
                               .unmask(1);  // Treat missing data as land

    // Mask water in NDVI
    ndvi = ndvi.updateMask(landMask);

    // 2. Use L2 surface temperature (ST_B10) directly
    //    ST_B10 has already been scaled to Kelvin in applyScaleFactors.
    var lstRaw = composite.select('ST_B10')
                           .subtract(273.15)        // Kelvin → °C
                           .rename('LST');

    // ✅ DEBUG: Check if LST is constant (indicating S2 fallback with no thermal)
    if (DEBUG_MODE) {
      lstRaw.reduceRegion({
        reducer: ee.Reducer.minMax(),
        geometry: region,
        scale: 100,
        maxPixels: 1e8
      }).evaluate(function(stats) {
        var range = stats.LST_max - stats.LST_min;
        if (range < 0.1) {
        } else {
        }
      });
    }

    var lstFinal = lstRaw.updateMask(lstRaw.gt(10).and(lstRaw.lt(80)))
                          .updateMask(landMask)
                          .setDefaultProjection('EPSG:4326', null, 30);

    // 3. Use the final masked LST
    var lst = lstFinal;

    // 4. Define cool reference pixels for SUHI calculation
    //    Reference = top 10-20% NDVI pixels (dynamically computed per city)
    //    This avoids "too few pixels" in arid cities while still selecting coolest vegetation

    // Compute NDVI percentiles within city bounds
    var ndviStats = ndvi.reduceRegion({
      reducer: ee.Reducer.percentile([80, 90]),
      geometry: region,
      scale: scales.ndvi,
      crs: 'EPSG:4326',
      bestEffort: true,
      tileScale: 4,
      maxPixels: 1e13
    });

    // Use 80th percentile as threshold (top 20% NDVI pixels)
    // Enforce minimum floor (0.30) to prevent drifting into bare soil/stressed vegetation
    var ndviThreshold = safeDictNumber(ndviStats, 'NDVI_p80', 0.5).max(0.30);

    // Create reference mask using dynamic threshold with floor
    var coolRefMask = ndvi.gte(ndviThreshold)
                          .and(landMask)
                          .selfMask();

    // Verify reference pixel count (for debugging) - skip to avoid memory issues
    var refPixelCount = 'not computed';  // Skip count to save memory


    // 5. Compute reference temperature (20th percentile LST = coolest vegetated pixels)
    //    Using p20 instead of median prevents bias from hot cropland/stressed vegetation
    //    Targets truly cool vegetation (well-watered parks, tree canopy)
    var refTemp = lst.updateMask(coolRefMask).reduceRegion({
      reducer: ee.Reducer.percentile([20]),
      geometry: region,
      scale: scales.lst,
      crs: 'EPSG:4326',
      bestEffort: true,
      tileScale: 4,
      maxPixels: 1e13
    });

    // For single-band percentile reducer, output key is bandName_pXX
    var refCool = safeDictNumber(refTemp, 'LST_p20', 30);  // Default 30°C if no reference pixels

    // 6. Surface Urban Heat Island (SUHI): ΔT = LST - reference LST (cool baseline)
    //    Positive values = hotter than coolest vegetation
    var uhi = lst.subtract(ee.Image.constant(refCool))
                     .rename('UHI');

    // 7. Also compute city-wide statistics for reporting
    var lstMean = lst.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: region,
      scale: scales.lst,
      crs: 'EPSG:4326',
      bestEffort: true,
      tileScale: 4,
      maxPixels: 1e13
    });

    var lstStd = lst.reduceRegion({
      reducer: ee.Reducer.stdDev(),
      geometry: region,
      scale: scales.lst,
      crs: 'EPSG:4326',
      bestEffort: true,
      tileScale: 4,
      maxPixels: 1e13
    });

    var mu = safeDictNumber(lstMean, 'LST', 35);
    var sd = safeDictNumber(lstStd, 'LST', 5).max(0.001);

    // Store statistics including reference baseline
    var lstStats = ee.Dictionary({
      'LST_mean': mu,
      'LST_stdDev': sd,
      'LST_coolRef': refCool,           // p20 of LST among coolest vegetation
      'SUHI_ndviThreshold': ndviThreshold,  // Dynamic threshold used (top 20% NDVI, min 0.30)
      'SUHI_refPixelCount': refPixelCount   // Number of reference pixels
    });

    // Clip to region for proper display

    lst = lst.clip(region);
    uhi = uhi.clip(region);
    ndvi = ndvi.clip(region);

    var result = {
      ndvi: ndvi,
      lst: lst,
      uhi: uhi,
      lstStats: lstStats
    };

    computeCache[cacheKey] = result;
    return result;

  } catch (e) {

    // Fallback: constant fields so the app still runs
    var defaultLST = ee.Image.constant(35).rename('LST').clip(region);
    var defaultNDVI = ee.Image.constant(0.3).rename('NDVI').clip(region);
    var defaultUHI = ee.Image.constant(0).rename('UHI').clip(region);

    return {
      ndvi: defaultNDVI,
      lst: defaultLST,
      uhi: defaultUHI,
      lstStats: ee.Dictionary({
        'LST_mean': 35,
        'LST_stdDev': 5,
        'LST_coolRef': 30,
        'SUHI_ndviThreshold': 0.3,
        'SUHI_refPixelCount': 'not computed'
      })
    };
  }
}

function processUrbanLayers(region, composite, cityConfig) {
  // Never throw from here — return fallbacks so the app still renders layers.
  try {
    var cacheKey = cityName + '_urban_' + startDate + '_' + endDate;
    if (computeCache[cacheKey]) return computeCache[cacheKey];

    // ---------- LULC (WorldCover) ----------
    // CRITICAL: Preserve projection through ee.Algorithms.If
    var wc = ee.ImageCollection('ESA/WorldCover/v200');
    var wcFirst = ee.Image(wc.first()).select('Map');
    // ✅ FIX: Use explicit projection instead of lazy-evaluated projection
    // WorldCover is 10m resolution in EPSG:4326
    var wcProj = ee.Projection('EPSG:4326').atScale(10);

    var lulc = ee.Image(ee.Algorithms.If(
      wc.size().gt(0),
      wcFirst,
      ee.Image.constant(50).rename('Map').setDefaultProjection(wcProj)
    )).setDefaultProjection(wcProj).clip(region);

    // ---------- HIGH-RESOLUTION ALBEDO FROM SENTINEL-2 (10m) ----------
    // PRIMARY SOURCE: Always use Sentinel-2 for albedo when available
    // This provides 3x better resolution than Landsat (10m vs 30m)
    // Critical for identifying individual rooftops and cool roof opportunities
    // Reference: Bonafoni S., Sekertekin A. (2020). "Albedo Retrieval from Sentinel-2
    // by New Narrow-to-Broadband Conversion Coefficients." IEEE GRSL, 17(9), 1618-1622.
    // doi:10.1109/LGRS.2020.2967085 - validated for urban areas

    var sentinel2Albedo = loadSentinel2ForAlbedo(region, startDate, endDate, summerFilter);

    // Fallback: Landsat 8/9 broadband albedo - Liang (2001), correct OLI mapping
    // albedo = 0.356*blue + 0.130*red + 0.373*NIR + 0.085*SWIR1 + 0.072*SWIR2 - 0.0018
    // L8/L9 OLI: SR_B2=blue, SR_B4=red, SR_B5=NIR, SR_B6=SWIR1, SR_B7=SWIR2
    var landsatAlbedoFallback = composite.select('SR_B2').multiply(0.356)
      .add(composite.select('SR_B4').multiply(0.130))
      .add(composite.select('SR_B5').multiply(0.373))
      .add(composite.select('SR_B6').multiply(0.085))
      .add(composite.select('SR_B7').multiply(0.072))
      .subtract(0.0018)
      .clamp(0, 1)
      .rename('albedo')
      .clip(region);

    // Blend: S2 primary, Landsat fills only masked S2 pixels
    var landsatAlbedo = sentinel2Albedo.unmask(landsatAlbedoFallback);


    // ---------- Impervious proxy from WorldCover built-up ----------
    var imperv = lulc.eq(50).multiply(100).rename('Impervious');

    // ---------- WorldPop Global 2 (R2025A) with fallback ----------
    // UPGRADE: Using WorldPop Global 2 (R2025A, Sept 2025 release)
    // Improvements over legacy WorldPop:
    //   - Building footprint integration (Google/Microsoft AI detection)
    //   - Circa-2020 census incorporation
    //   - Enhanced settlement mapping (PD-SEG deep learning)
    //   - Better urban density detection for heat risk analysis
    // Fallback to legacy WorldPop if R2025A unavailable

    var worldpop;

    // Nominal 100 m grid: used ONLY when the primary WorldPop image is
    // unavailable (R2025A mosaic / built-fraction proxy carry no usable grid).
    var wpFallbackProj = ee.Projection('EPSG:4326').atScale(scales.population);
    var wpNativeProj = null;

    // ✅ FIX: Use official WorldPop GP/100m/pop which has reliable India 2020 data
    // R2025A community catalog doesn't have metadata filtering by country/year
    try {
      if (DEBUG_MODE) {
      }

      // Primary source: Official WorldPop GP/100m/pop
      var wpColl = ee.ImageCollection("WorldPop/GP/100m/pop")
        .filter(ee.Filter.eq('country', 'IND'))
        .filter(ee.Filter.eq('year', 2020))
        .filterBounds(region);

      var wpCount = wpColl.size();

      if (DEBUG_MODE) {
        wpCount.evaluate(function(count) {
        });
      }

      // Get first image (India should have a single nationwide image for 2020)
      var wpImg = ee.Image(ee.Algorithms.If(
        wpCount.gt(0),
        wpColl.first().select('population'),
        // Fallback: Try R2025A community catalog with geometry filter only
        ee.ImageCollection("projects/sat-io/open-datasets/WORLDPOP/pop")
          .filterBounds(region)
          .mosaic()
          .select('population')
      ));

      worldpop = wpImg.clip(region).unmask(0);

      // Native WorldPop grid (~0.000833 deg, ~93 m), taken from the source
      // image itself so no hard-coded transform can drift from the dataset.
      wpNativeProj = ee.Projection(ee.Algorithms.If(
        wpCount.gt(0),
        wpColl.first().select('population').projection(),
        wpFallbackProj
      ));

      if (DEBUG_MODE) {
      }

    } catch (err) {
      // Ultimate fallback: Generate population estimate from built-up areas

      // Use built-up fraction as population proxy (very rough estimate)
      // Assume 100 people per hectare in built-up areas
      var builtFrac = lulc.eq(50).rename('built');  // WorldCover built-up class
      worldpop = builtFrac
        .multiply(100)  // 100 people per 100m cell if fully built
        .rename('population')
        .clip(region)
        .unmask(0);
    }

    // Pin the image to its OWN native grid. The previous nominal 100 m
    // EPSG:4326 grid (0.000898 deg) is coarser than WorldPop's 0.000833 deg
    // cells, so the per-pixel head counts were resampled onto a sparser
    // lattice and every ward sum lost ~14% of people before any ward
    // aggregation ran. Every population sum downstream now reduces at
    // worldpop.projection() and therefore counts each source pixel exactly once.
    worldpop = worldpop.setDefaultProjection(wpNativeProj || wpFallbackProj);

    // ---------- Nightlights (VIIRS, robust) ----------
    var night;
    try {
      // ✅ FIX B: Align VIIRS date window with analysis period (use endDate, not current year)
      var analysisEnd = ee.Date(endDate);
      var nightStart = analysisEnd.advance(-2, 'year');  // 2 years before analysis end
      var nightEnd = analysisEnd;

      var nightColl = ee.ImageCollection('NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG')
        .filterBounds(region)
        .filterDate(nightStart, nightEnd)
        .select('avg_rad');

      // ❌ DISABLED: Forces evaluation

      // ✅ FIX A: Don't read projection from potentially empty median
      // Use explicit VIIRS projection instead
      var viirsProj = ee.Projection('EPSG:4326').atScale(463.83);  // VIIRS native ~463m
      var nightFallback = imperv.multiply(0.5).add(lulc.eq(50).multiply(10)).rename('avg_rad');

      night = ee.Image(ee.Algorithms.If(
        nightColl.size().gt(0),
        nightColl.median().setDefaultProjection(viirsProj),
        nightFallback.setDefaultProjection(viirsProj)
      )).setDefaultProjection(viirsProj).clip(region).unmask(0);

    } catch (inner) {
      var viirsProj = ee.Projection('EPSG:4326').atScale(463.83);
      night = imperv.multiply(0.5)
        .add(lulc.eq(50).multiply(10))
        .rename('avg_rad')
        .setDefaultProjection(viirsProj)
        .clip(region)
        .unmask(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // GHSL NON-RESIDENTIAL: Filter for commercial/industrial zones
    // ─────────────────────────────────────────────────────────────────────────
    // Used to filter nightlights to non-residential areas only
    // Solves confounding where well-lit residential areas score high on nightlights
    // but are NOT economic activity zones (markets, industrial, transport)
    var ghsl_nres;
    try {
      // Load GHSL NRES from 100m direct asset path (NRES band only available at 100m, not 10m)
      // CRITICAL FIX: Use direct asset path instead of ImageCollection filter
      // The collection images may not have 'year' property, causing filter to return empty
      // and NRES to fall back to constant 0, breaking 24-Hour Heat Zones vulnerability
      ghsl_nres = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_S/2025")
        .select('built_surface_nres')
        .clip(region)
        .setDefaultProjection(ee.Projection('EPSG:4326').atScale(100));  // Native 100m resolution

      // Verify NRES loaded correctly
      var nresTest = ghsl_nres.reduceRegion({
        reducer: ee.Reducer.count(),
        geometry: region,
        scale: 1000,
        maxPixels: 1e6
      });
      nresTest.evaluate(function(result) {
        if (result && result.built_surface_nres > 0) {
          print('✓ GHSL NRES loaded successfully (' + result.built_surface_nres + ' pixels)');
        } else {
          print('⚠️  WARNING: GHSL NRES may be empty - check asset availability');
        }
      });

    } catch (nresError) {
      // Fallback: assume all built areas are non-residential (no filtering)
      print('❌ ERROR loading GHSL NRES: ' + nresError.message);
      print('⚠️  IMPACT: 24-Hour Heat Zones vulnerability will default to floor (0.01)');

      ghsl_nres = lulc.eq(50).multiply(100).rename('built_surface_nres')
        .setDefaultProjection(ee.Projection('EPSG:4326').atScale(100));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MODIS LST: Terra + Aqua for 24-hour temperature coverage
    // ─────────────────────────────────────────────────────────────────────────
    // MODIS provides 4 daily passes for true diurnal cycle:
    //   Terra: 10:30 AM (day), 10:30 PM (night)
    //   Aqua:  1:30 PM (day), 1:30 AM (night)
    // Used by 24-Hour Activity Heat Zones layer
    var modisDay, modisNight;

    try {
      var modisStart = analysisEnd.advance(-2, 'year');
      var modisEnd = analysisEnd;
      var modisProj = ee.Projection('EPSG:4326').atScale(1000);  // Native 1km

      // Load Terra (MOD11A1) and Aqua (MYD11A1) daily LST
      var terraColl = ee.ImageCollection('MODIS/061/MOD11A1')
        .filterBounds(region)
        .filterDate(modisStart, modisEnd)
        .select(['LST_Day_1km', 'LST_Night_1km']);

      var aquaColl = ee.ImageCollection('MODIS/061/MYD11A1')
        .filterBounds(region)
        .filterDate(modisStart, modisEnd)
        .select(['LST_Day_1km', 'LST_Night_1km']);

      // Convert from Kelvin to Celsius and compute medians
      var convertToC = function(img) {
        return img.multiply(0.02).subtract(273.15);
      };

      var terraDay = terraColl.select('LST_Day_1km').map(convertToC).median();
      var terraNight = terraColl.select('LST_Night_1km').map(convertToC).median();
      var aquaDay = aquaColl.select('LST_Day_1km').map(convertToC).median();
      var aquaNight = aquaColl.select('LST_Night_1km').map(convertToC).median();

      // Average Terra + Aqua for robust day/night estimates. The average is
      // only valid when BOTH collections have scenes: adding a median taken
      // over an empty collection errors, so a single-sensor window falls
      // back to that sensor alone, and no MODIS at all falls back to Landsat.
      var hasTerra = terraColl.size().gt(0);
      var hasAqua = aquaColl.size().gt(0);
      var pickModis = function(terraImg, aquaImg) {
        return ee.Algorithms.If(
          hasTerra.and(hasAqua), terraImg.add(aquaImg).divide(2),
          ee.Algorithms.If(hasTerra, terraImg,
            ee.Algorithms.If(hasAqua, aquaImg, lst)));  // Fallback to Landsat LST
      };

      modisDay = ee.Image(pickModis(terraDay, aquaDay))
        .setDefaultProjection(modisProj).clip(region).rename('MODIS_Day_LST');

      modisNight = ee.Image(pickModis(terraNight, aquaNight))
        .setDefaultProjection(modisProj).clip(region).rename('MODIS_Night_LST');

    } catch (modisError) {
      var modisProj = ee.Projection('EPSG:4326').atScale(1000);
      modisDay = lst.setDefaultProjection(modisProj).clip(region).rename('MODIS_Day_LST');
      modisNight = lst.setDefaultProjection(modisProj).clip(region).rename('MODIS_Night_LST');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CROPLAND EXCLUSION FOR 24-HOUR HEAT ZONES (ACTIVITY HEAT STRESS)
    // ═══════════════════════════════════════════════════════════════════════
    // Exclude cropland from MODIS LST analysis to focus on urban heat exposure
    // ESA WorldCover class 40 = Cropland
    // Aggregate from 10m to 1km MODIS resolution using mean reducer
    // Threshold: Exclude pixels with >50% cropland coverage at 1km scale
    // Applied BEFORE all calculations for efficiency
    try {
      // Create binary cropland mask at 10m native resolution
      var cropMask_10m = lulc.unmask(0).eq(40);

      // Aggregate to 1km to match MODIS resolution
      // Mean reducer gives crop fraction (0-1) at 1km scale
      var cropFrac_1km = cropMask_10m
        .reduceResolution({
          reducer: ee.Reducer.mean(),
          maxPixels: 65536
        })
        .reproject({
          crs: modisProj,
          scale: 1000
        });

      // Create NOT-cropland mask (true for pixels with <50% cropland)
      var notCrop_1km = cropFrac_1km.lt(0.5);

      // Apply mask to MODIS LST data
      // Masked pixels become null and are excluded from ward aggregation
      modisDay = modisDay.updateMask(notCrop_1km);
      modisNight = modisNight.updateMask(notCrop_1km);

    } catch (cropMaskError) {
      // Silently continue if cropland masking fails (preserve existing behavior)
    }

    // ✅ CHALLENGE 2 FIX: Compute 100m masks ONCE here, reuse everywhere
    var WC_CRS = 'EPSG:4326';
    var WC_SCALE = 10;
    var POP_CRS = 'EPSG:4326';
    var POP_SCALE = 100;
    var wcProj = ee.Projection(WC_CRS).atScale(WC_SCALE);
    var popProj = ee.Projection(POP_CRS).atScale(POP_SCALE);

    // Built fraction at 100m (used by Tree, Cool Roof, Population layers)
    // Use aggregateImage helper for consistent projection handling (10m → 100m)
    var built10 = lulc.unmask(0).eq(50);
    var builtFrac100 = aggregateImage(built10, 10, 100, 'mean', 4096)
      .rename('builtFrac100');

    // Crop fraction at 100m (used by Tree, Cool Roof, Population layers)
    // Use aggregateImage helper for consistent projection handling (10m → 100m)
    var crop10 = lulc.unmask(0).eq(40);
    var cropFrac100 = aggregateImage(crop10, 10, 100, 'mean', 4096)
      .rename('cropFrac100');

    // Tree canopy from Dynamic World at 100m (used by Tree layer)
    var canopyEnd = ee.Date(endDate);
    var canopyStart = canopyEnd.advance(-6, 'month');
    var dwTrees = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
      .filterBounds(region)
      .filterDate(canopyStart, canopyEnd)
      .select('trees');

    var dwTreesSize = dwTrees.size();
    var treeProb10_raw = ee.Image(ee.Algorithms.If(
      dwTreesSize.gt(0),
      dwTrees.median(),
      lulc.eq(10).multiply(0.8)  // Fallback: WorldCover tree class
    )).setDefaultProjection(wcProj).clip(region);

    // Normalize to 0-1 (DW can be 0-100 or 0-1)
    var treeProb10 = treeProb10_raw
      .where(treeProb10_raw.gt(1.5), treeProb10_raw.divide(100))
      .rename('trees');

    // Exclude cropland from canopy
    var notCrop10 = lulc.unmask(0).neq(40).setDefaultProjection(wcProj);
    var canopyProb10 = treeProb10.toFloat().updateMask(notCrop10).rename('canopyProb10');
    canopyProb10 = canopyProb10.where(canopyProb10.lt(0.10), 0); // Noise floor

    // Use aggregateImage helper for consistent projection handling (10m → 100m)
    var canopyFrac100 = aggregateImage(canopyProb10, 10, 100, 'mean', 4096)
      .rename('canopyFrac100');

    // ✅ PERFORMANCE: Cache Dynamic World built probability (used by Informal Housing layer)
    var builtStart = ee.Date(endDate).advance(-6, 'month');
    var builtEnd = ee.Date(endDate);
    var dwBuiltCol = ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1')
      .filterBounds(region)
      .filterDate(builtStart, builtEnd)
      .select('built');

    var dwBuiltSize = dwBuiltCol.size();
    var dwBuiltMean = dwBuiltCol.mean();

    var dwBuiltProb = ee.Image(ee.Algorithms.If(
      dwBuiltSize.gt(0),
      dwBuiltMean,
      lulc.eq(50).multiply(0.8)  // Fallback from WorldCover if DW unavailable
    )).setDefaultProjection(wcProj).clip(region);

    var result = {
      lulc: lulc,
      albedo: landsatAlbedo,  // Now primarily from Sentinel-2 at 10m resolution
      imperv: imperv,
      population: worldpop,
      nightlights: night,
      ghsl_nres: ghsl_nres,        // ✅ GHSL Non-Residential built surface (10m, 2018)
      modisDay: modisDay,          // ✅ MODIS daytime LST (Terra+Aqua average, 1km)
      modisNight: modisNight,      // ✅ MODIS nighttime LST (Terra+Aqua average, 1km)
      builtFrac100: builtFrac100,  // ✅ Fraction at 100m (cached!)
      cropFrac100: cropFrac100,    // ✅ Fraction at 100m (cached!)
      canopyFrac100: canopyFrac100, // ✅ Canopy at 100m (cached!)
      dwBuiltProb: dwBuiltProb     // ✅ PERFORMANCE: Dynamic World built probability (cached!)
    };

    computeCache[cacheKey] = result;
    return result;

  } catch (e) {
    // Log error and return fallbacks for EVERY key the callers read. The
    // previous six-key object made the fallback itself throw downstream
    // (urbanData.modisNight / builtFrac100 / dwBuiltProb were undefined).
    // Constant images carry a real grid so reductions keyed off
    // population.projection() (computeWardPopulation) still have a scale.
    var fb100 = ee.Projection('EPSG:4326').atScale(100);
    var fb1km = ee.Projection('EPSG:4326').atScale(1000);
    var lstFallback = (typeof lst !== 'undefined' && lst)
      ? lst : ee.Image.constant(30).setDefaultProjection(fb1km);
    return {
      lulc: ee.Image.constant(50).rename('Map').clip(region),
      albedo: ee.Image.constant(0.2).rename('albedo').clip(region),
      imperv: ee.Image.constant(0).rename('Impervious').clip(region),
      population: ee.Image.constant(0).rename('population')
        .setDefaultProjection(fb100).clip(region),
      nightlights: ee.Image.constant(0).rename('avg_rad').clip(region),
      ghsl_nres: ee.Image.constant(0).rename('built_surface_nres').clip(region),
      modisDay: lstFallback.setDefaultProjection(fb1km).clip(region).rename('MODIS_Day_LST'),
      modisNight: lstFallback.setDefaultProjection(fb1km).clip(region).rename('MODIS_Night_LST'),
      builtFrac100: ee.Image.constant(0).rename('builtFrac100').setDefaultProjection(fb100).clip(region),
      cropFrac100: ee.Image.constant(0).rename('cropFrac100').setDefaultProjection(fb100).clip(region),
      canopyFrac100: ee.Image.constant(0).rename('canopyFrac100').setDefaultProjection(fb100).clip(region),
      dwBuiltProb: ee.Image.constant(0).rename('built').setDefaultProjection(fb100).clip(region)
    };
  }
}

function calculateWardHeatIndicators(wards, lst, uhi, lulc, cityConfig, cityMeanLST) {

  try {
    // ⚡ LAYER CACHE: return the finished ward table. It was exported AFTER
    // the modisNight join + cooling-potential map in runAnalysis, so those
    // re-apply onto it with identical values (cheap; overwrite is a no-op).
    if (cityHasLayerCache(cityName)) {
      return ee.FeatureCollection(cacheAssetId(cityName, 'lst_wards'));
    }

    // Create built-surface mask (ESA WorldCover class 50 = Built-up)
    var builtMask = lulc.eq(50).selfMask();

    // Compute UHI anomaly statistics — BUILT SURFACES ONLY
    // This is more actionable for cool roof/pavement interventions
    var uhiBuiltOnly = uhi.updateMask(builtMask);

    // ✅ OPTIMIZATION: Combine all three images into ONE reduceRegions call
    // This prevents chained operations creating deep dependency trees
    var combinedBands = lst.rename('LST')
      .addBands(uhi.rename('UHI_all'))
      .addBands(uhiBuiltOnly.rename('UHI_built'));

    // Single reduceRegions call with combined reducer
    // UNIFORM 30m for ALL cities (Delhi included). Delhi previously ran at 60m
    // as a runtime compromise; with the Landsat composite cached as an asset
    // and the heat-risk ward table exported once, the 30m cost is paid at
    // export time only - app users load the finished table. Methodology is
    // now identical across all 15 cities.
    var analysisScale = scales.lst;  // 30m everywhere
    var analysisTileScale = (cityConfig.areaKm2 > 1400) ? 16 : 8;  // memory guard only; does not affect outputs

    var uhiBuiltByWard = combinedBands.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.mean()
        .combine(ee.Reducer.stdDev(), '', true)
        .combine(ee.Reducer.min(), '', true)
        .combine(ee.Reducer.max(), '', true)
        .combine(ee.Reducer.percentile([10, 25, 75, 90]), '', true),
      scale: analysisScale,
      crs: 'EPSG:4326',
      tileScale: analysisTileScale,
      maxPixelsPerRegion: 1e8  // ✅ Reduced from 1e9
    });

    uhiBuiltByWard = uhiBuiltByWard.map(function(ward) {
      var wardNo = ee.Number(ward.get('WARD_NO'));

      // LST statistics
      var lstMean = getNumber(ward, 'LST_mean', 35);
      var lstStdDev = getNumber(ward, 'LST_stdDev', 1);
      var lstMin = getNumber(ward, 'LST_min', 30);
      var lstMax = getNumber(ward, 'LST_max', 40);
      var lstP10 = getNumber(ward, 'LST_p10', 32);
      var lstP25 = getNumber(ward, 'LST_p25', 33);
      var lstP75 = getNumber(ward, 'LST_p75', 37);
      var lstP90 = getNumber(ward, 'LST_p90', 38);

      // LST derived metrics
      var lstRange = lstMax.subtract(lstMin);
      var lstCv = lstStdDev.divide(lstMean.max(0.1)).multiply(100);
      var lstIqr = lstP75.subtract(lstP25);
      var hotspotIntensity = lstP90.subtract(lstP10);
      var lstHeterogeneityFlag = ee.String(ee.Algorithms.If(
        lstCv.gt(8),  // CV > 8%
        'High',
        ee.Algorithms.If(lstCv.gt(5), 'Medium', 'Low')
      ));

      // Absolute temperature score (for "Land Surface Temperature" layer)
      var heatScore = lstMean.multiply(0.3)
                    .add(lstMax.multiply(0.3))
                    .add(lstP90.multiply(0.4));

      // LST deviation from city mean (hotspot indicator)
      var lstHotspot = lstMean.subtract(cityMeanLST);

      // UHI ALL LAND statistics
      var uhiAllMean = getNumber(ward, 'UHI_all_mean', 0);
      var uhiAllStdDev = getNumber(ward, 'UHI_all_stdDev', 0);
      var uhiAllMin = getNumber(ward, 'UHI_all_min', 0);
      var uhiAllMax = getNumber(ward, 'UHI_all_max', 0);
      var uhiAllP10 = getNumber(ward, 'UHI_all_p10', 0);
      var uhiAllP25 = getNumber(ward, 'UHI_all_p25', 0);
      var uhiAllP75 = getNumber(ward, 'UHI_all_p75', 0);
      var uhiAllP90 = getNumber(ward, 'UHI_all_p90', 0);

      // UHI ALL derived metrics
      var uhiAllRange = uhiAllMax.subtract(uhiAllMin);
      var uhiAllCv = uhiAllStdDev.divide(uhiAllMean.abs().max(0.1)).multiply(100);

      // UHI BUILT ONLY statistics
      var uhiBuiltMean = getNumber(ward, 'UHI_built_mean', 0);
      var uhiBuiltStdDev = getNumber(ward, 'UHI_built_stdDev', 0);
      var uhiBuiltMin = getNumber(ward, 'UHI_built_min', 0);
      var uhiBuiltMax = getNumber(ward, 'UHI_built_max', 0);
      var uhiBuiltP90 = getNumber(ward, 'UHI_built_p90', 0);

      // UHI BUILT derived metrics
      var uhiBuiltCv = uhiBuiltStdDev.divide(uhiBuiltMean.abs().max(0.1)).multiply(100);

      return ward.set({
        'WARD_NO': wardNo,
        // LST - all statistics
        'LST_mean': lstMean,
        'LST_stdDev': lstStdDev,
        'LST_cv': lstCv,
        'LST_min': lstMin,
        'LST_p10': lstP10,
        'LST_p25': lstP25,
        'LST_p75': lstP75,
        'LST_p90': lstP90,
        'LST_max': lstMax,
        'LST_range': lstRange,
        'LST_iqr': lstIqr,
        'LST_heterogeneity_flag': lstHeterogeneityFlag,
        'hotspot_intensity': hotspotIntensity,
        'heat_score': heatScore,
        'LST_hotspot': lstHotspot,
        // UHI All-land - all statistics
        'UHI_all_mean': uhiAllMean,
        'UHI_all_stdDev': uhiAllStdDev,
        'UHI_all_cv': uhiAllCv,
        'UHI_all_min': uhiAllMin,
        'UHI_all_p10': uhiAllP10,
        'UHI_all_p25': uhiAllP25,
        'UHI_all_p75': uhiAllP75,
        'UHI_all_p90': uhiAllP90,
        'UHI_all_max': uhiAllMax,
        'UHI_all_range': uhiAllRange,
        // UHI Built-only - all statistics
        'UHI_built_mean': uhiBuiltMean,
        'UHI_built_stdDev': uhiBuiltStdDev,
        'UHI_built_cv': uhiBuiltCv,
        'UHI_built_min': uhiBuiltMin,
        'UHI_built_p90': uhiBuiltP90,
        'UHI_built_max': uhiBuiltMax
      });
    });

    // ✅ VERIFICATION: Print sample ward statistics to console

    return uhiBuiltByWard;
  } catch (e) {
    return createDefaultWardResults(wards);
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// SUPPLEMENTAL WARD DATA - Additional variables for Excel export
// ════════════════════════════════════════════════════════════════════════════════
// Aggregates input variables not captured by primary layer calculations:
// - NDVI, tree probability, DW built probability, vegetation deficit,
//   GHSL built density normalized, dimness, MODIS night LST
function calculateSupplementalWardData(wards, ndvi, lulc, nightlights, urbanData, cityBoundary, cityConfig) {
  try {
    // Load GHSL Built Surface 2025 for density calculation
    var ghslBuiltS = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_S/2025")
      .select('built_surface')
      .clip(cityBoundary);

    // Create built mask for normalization
    var ghslMask = ghslBuiltS.gte(1000);
    var worldCoverMask = lulc.eq(50);
    var builtMask = ghslMask.and(worldCoverMask);

    // ─────────────────────────────────────────────────────────────────────
    // 1. GHSL BUILT DENSITY NORMALIZED (Component 1 of Informal Housing)
    // ─────────────────────────────────────────────────────────────────────
    var densityStats = ghslBuiltS.updateMask(builtMask).reduceRegion({
      reducer: ee.Reducer.percentile([5, 95]),
      geometry: cityBoundary,
      scale: 100,
      bestEffort: true,
      maxPixels: 1e8
    });

    // Null-safe: an empty built mask yields null percentiles, and
    // ee.Number(null).max() errors server-side
    var densityP5 = safeDictNumber(densityStats, 'built_surface_p5', 0).max(0);
    var densityP95 = safeDictNumber(densityStats, 'built_surface_p95', 0).max(densityP5.add(1));
    var densityRange = densityP95.subtract(densityP5).max(1);

    var densityNorm = ghslBuiltS
      .subtract(densityP5)
      .divide(densityRange)
      .clamp(0, 1)
      .multiply(100)
      .updateMask(builtMask)
      .rename('ghslDensity');

    // ─────────────────────────────────────────────────────────────────────
    // 2. NIGHTLIGHT DIMNESS (Component 3 of Informal Housing)
    // ─────────────────────────────────────────────────────────────────────
    var dimnessNorm;
    if (nightlights) {
      var nightlightStats = nightlights.updateMask(builtMask).reduceRegion({
        reducer: ee.Reducer.percentile([5, 95]),
        geometry: cityBoundary,
        scale: 500,
        bestEffort: true,
        maxPixels: 1e8
      });

      var nightP5 = ee.Number(nightlightStats.get('avg_rad_p5')).max(0);
      var nightP95 = ee.Number(nightlightStats.get('avg_rad_p95')).max(nightP5.add(0.1));
      var nightRange = nightP95.subtract(nightP5).max(0.1);

      var brightnessNorm = nightlights
        .subtract(nightP5)
        .divide(nightRange)
        .clamp(0, 1);

      dimnessNorm = ee.Image.constant(1)
        .subtract(brightnessNorm)
        .multiply(100)
        .clamp(0, 100)
        .updateMask(builtMask)
        .rename('dimness');
    } else {
      dimnessNorm = ee.Image.constant(50).updateMask(builtMask).rename('dimness');
    }

    // ─────────────────────────────────────────────────────────────────────
    // 3. VEGETATION DEFICIT (Component 4 of Informal Housing)
    // ─────────────────────────────────────────────────────────────────────
    var isVegetation = lulc.eq(10).or(lulc.eq(20)).or(lulc.eq(30));
    var vegFrac100 = aggregateImage(isVegetation, 10, 100, 'mean', 1024)
      .clip(cityBoundary);

    var vegStats = vegFrac100.updateMask(builtMask).reduceRegion({
      reducer: ee.Reducer.percentile([5, 95]),
      geometry: cityBoundary,
      scale: 100,
      bestEffort: true,
      maxPixels: 1e8
    });

    var vegP5 = ee.Number(vegStats.get('Map_p5')).max(0);
    var vegP95 = ee.Number(vegStats.get('Map_p95')).max(vegP5.add(0.01));
    var vegRange = vegP95.subtract(vegP5).max(0.01);

    var vegNorm = vegFrac100
      .subtract(vegP5)
      .divide(vegRange)
      .clamp(0, 1);

    var vegDeficitNorm = ee.Image.constant(1)
      .subtract(vegNorm)
      .multiply(100)
      .clamp(0, 100)
      .updateMask(builtMask)
      .rename('vegDeficit');

    // ─────────────────────────────────────────────────────────────────────
    // 4. COMBINE ALL VARIABLES INTO MULTI-BAND IMAGE
    // ─────────────────────────────────────────────────────────────────────
    // NDVI (30m), MODIS night (1km), DW tree prob (10m→100m), DW built prob (10m),
    // density, dimness, vegDeficit

    // Aggregate Dynamic World tree probability to 100m
    var treeProb100 = ee.Image(0);
    if (urbanData.canopyFrac100) {
      treeProb100 = urbanData.canopyFrac100.multiply(100).rename('treeProb');
    } else {
      var treeMask = lulc.eq(10);
      treeProb100 = aggregateImage(treeMask, 10, 100, 'mean', 1024)
        .multiply(100)
        .clip(cityBoundary)
        .rename('treeProb');
    }

    // DW Built probability at 10m
    var dwBuilt10 = urbanData.dwBuiltProb.multiply(100).rename('dwBuiltProb');

    // Combine into single multi-band image for efficient reduceRegions
    var combinedBands = ndvi.rename('ndvi')
      .addBands(urbanData.modisNight.rename('nightLST'))
      .addBands(treeProb100)
      .addBands(dwBuilt10)
      .addBands(densityNorm)
      .addBands(dimnessNorm)
      .addBands(vegDeficitNorm);

    // ─────────────────────────────────────────────────────────────────────
    // 5. WARD AGGREGATION
    // ─────────────────────────────────────────────────────────────────────
    var tileScale = (cityConfig.areaKm2 > 1400) ? 16 : 8;

    var wardStats = combinedBands.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.mean(),
      scale: 100,
      crs: 'EPSG:4326',
      tileScale: tileScale
    }).map(function(ward) {
      return ward.set({
        'ndvi_mean': getNumber(ward, 'ndvi', 0.3),
        'nightLST_mean': getNumber(ward, 'nightLST', 30),
        'treeProb_mean': getNumber(ward, 'treeProb', 0),
        'dwBuiltProb_mean': getNumber(ward, 'dwBuiltProb', 0),
        'ghslDensity_mean': getNumber(ward, 'ghslDensity', 0),
        'dimness_mean': getNumber(ward, 'dimness', 50),
        'vegDeficit_mean': getNumber(ward, 'vegDeficit', 50)
      });
    });

    return wardStats;

  } catch (e) {
    // Return wards with default values
    return wards.map(function(ward) {
      return ward.set({
        'ndvi_mean': 0.3,
        'nightLST_mean': 30,
        'treeProb_mean': 0,
        'dwBuiltProb_mean': 0,
        'ghslDensity_mean': 0,
        'dimness_mean': 50,
        'vegDeficit_mean': 50
      });
    });
  }
}

// Universal image aggregation helper with explicit projection handling
// CRITICAL: Always use explicit projection objects (not deferred from image.projection())
// to avoid silent failures with reduceResolution and reproject operations.
/**
 * @param {ee.Image} img - Input image to aggregate
 * @param {number} srcScale - Source resolution in meters (e.g., 10, 30, 100)
 * @param {number} targetScale - Target resolution in meters (must be larger than srcScale)
 * @param {string} reducer - Reducer type: 'mean', 'max', 'min', 'median' (default: 'mean')
 * @param {number} maxPixels - Max pixels for reduceResolution (default: 4096)
 * @returns {ee.Image} - Aggregated image at target resolution with explicit projection
 *
 * @example
 * // Aggregate 10m vegetation to 100m using mean
 * var veg100 = aggregateImage(vegMask10m, 10, 100, 'mean', 1024);
 *
 * // Aggregate 30m LST to 100m using max
 * var lst100 = aggregateImage(lst30m, 30, 100, 'max', 1024);
 */
function aggregateImage(img, srcScale, targetScale, reducer, maxPixels) {
  reducer = reducer || 'mean';
  maxPixels = maxPixels || 4096;

  // Create EXPLICIT projection objects (prevents deferred projection issues)
  var crs = 'EPSG:4326';
  var srcProj = ee.Projection(crs).atScale(srcScale);
  var targetProj = ee.Projection(crs).atScale(targetScale);

  // Select reducer
  var reducerObj;
  switch(reducer.toLowerCase()) {
    case 'max': reducerObj = ee.Reducer.max(); break;
    case 'min': reducerObj = ee.Reducer.min(); break;
    case 'median': reducerObj = ee.Reducer.median(); break;
    default: reducerObj = ee.Reducer.mean();
  }

  return img
    .setDefaultProjection(srcProj)
    .reduceResolution({reducer: reducerObj, maxPixels: maxPixels})
    .reproject(targetProj);
}

// ════════════════════════════════════════════════════════════════════════════════
// SHARED METRICS CACHE - Compute once, reuse across all layers
// ════════════════════════════════════════════════════════════════════════════════
//
// OBJECTIVE: Eliminate redundant LST percentile computations across layers
//           - LST P75 used by: Population Heat Exposure
//           - LST P5/P95 used by: Cool Roof, Tree Planting, Heat Risk Index
//
// PERFORMANCE IMPACT:
//   - Before: 3+ separate reduceRegion calls (LST percentiles computed 3+ times)
//   - After: 1 single reduceRegion call (compute once, cache for all layers)
//   - Speedup: Eliminates ~10-20 seconds of redundant computation
//
// ════════════════════════════════════════════════════════════════════════════════

function computeSharedMetrics(lst, cityBoundary) {
  var POP_SCALE = 100;
  var SHARED_TILESCALE = 4;  // Will be overridden for Delhi in main function
  var popProj = ee.Projection('EPSG:4326').atScale(POP_SCALE);

  // ✅ PERFORMANCE: Resample LST to 100m once (used by population layer)
  // Use aggregateImage helper with explicit projections (LST is 30m native)
  var lst100 = aggregateImage(lst, 30, POP_SCALE, 'max', 1024);

  // ✅ HIGH-RESOLUTION LST: Use original 30m LST (already has projection from source)
  // LST already has 30m projection set at line 2987
  var lst30 = lst;

  // ✅ SHARED COMPUTATION: Compute all LST percentiles in ONE operation
  // Replaces 3+ separate reduceRegion calls across different layers
  // Calculated on ALL land pixels (water-masked)
  var lstStats = lst100.reduceRegion({
    reducer: ee.Reducer.percentile([5, 75, 95]).setOutputs(['p5', 'p75', 'p95']),
    geometry: cityBoundary,
    scale: POP_SCALE,
    bestEffort: true,
    maxPixels: 1e8,
    tileScale: 4
  });

  return {
    lst100: lst100,  // Reusable 100m LST (for population layer)
    lst30: lst30,    // ✅ NATIVE RES: 30m LST (for reviewer visualization)
    popProj: popProj,  // Shared projection object
    lstP5: safeDictNumber(lstStats, 'LST_p5', 30),
    lstP75: safeDictNumber(lstStats, 'LST_p75', 40).max(35),  // Hot threshold (min 35°C) - Fixed band name prefix
    lstP95: safeDictNumber(lstStats, 'LST_p95', 50),
    cityBoundary: cityBoundary
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// SHARED POPULATION AGGREGATION - Compute once, use everywhere
// ════════════════════════════════════════════════════════════════════════════════
function computeWardPopulation(wards, worldpop, cityConfig, cropFrac100, builtFrac100) {
  // Population is summed on WorldPop's native grid for EVERY city (see the
  // crs argument below). The former 100/150/250 m tiers resampled a
  // per-pixel count raster, which scales the total by the sampling ratio
  // (100 m nominal: ~0.86x; 150 m: ~0.38x; 250 m: ~0.14x). Memory is
  // handled by tileScale, not by coarsening the grid.
  var tileScale = (cityConfig.areaKm2 > 1400) ? 16 :
                  (cityConfig.areaKm2 < 150) ? 16 : 12;

  var simplifyTolerance = (cityConfig.areaKm2 > 1000) ? 100 :
                          (cityConfig.areaKm2 > 500)  ? 75 : 50;

  // Simplify ward geometries for faster aggregation
  var wardsSimplified = wards.map(function(f) {
    return f.simplify({maxError: simplifyTolerance});
  });

  // Combine population + LULC fractions into single image for efficient aggregation
  var combinedBands = worldpop.unmask(0).rename('population')
    .addBands(cropFrac100.rename('cropFrac'))
    .addBands(builtFrac100.rename('builtFrac'));

  // Single reduceRegions call for population and LULC statistics
  var popWards = combinedBands.reduceRegions({
    collection: wardsSimplified,
    reducer: ee.Reducer.sum().setOutputs(['totalPop'])
      .combine(ee.Reducer.mean(), '', true),  // Adds cropFrac_mean, builtFrac_mean
    // No scale: the image's first band is WorldPop, so the reduction runs on
    // its native grid and counts each source pixel exactly once.
    crs: worldpop.projection(),
    tileScale: tileScale,
    maxPixelsPerRegion: 1e7
  });

  // Pre-compute area and LULC percentages for each ward
  return popWards.map(function(f) {
    var existing = f.get('area_km2');
    var areaKm2 = ee.Number(ee.Algorithms.If(
      ee.Algorithms.IsEqual(existing, null),
      ee.Number(f.geometry().area(1)).divide(1e6),
      existing
    ));

    // Extract LULC fractions and convert to percentages (with null handling)
    var cropFrac = ee.Number(ee.Algorithms.If(
      ee.Algorithms.IsEqual(f.get('cropFrac_mean'), null),
      0,
      f.get('cropFrac_mean')
    ));
    var builtFrac = ee.Number(ee.Algorithms.If(
      ee.Algorithms.IsEqual(f.get('builtFrac_mean'), null),
      0,
      f.get('builtFrac_mean')
    ));
    var cropPct = cropFrac.multiply(100).clamp(0, 100);
    var builtPct = builtFrac.multiply(100).clamp(0, 100);

    // The sum+mean reducer is repeated per band on a 3-band image, so Earth
    // Engine prefixes every output with its band name: the population sum
    // arrives as 'population_totalPop' (exactly as 'cropFrac_mean' does
    // above). The bare 'totalPop' read was always null -> 0. Read the
    // prefixed name first and keep the bare name as a fallback.
    var rawPop = ee.Algorithms.If(
      ee.Algorithms.IsEqual(f.get('population_totalPop'), null),
      f.get('totalPop'),
      f.get('population_totalPop')
    );
    var totalPop = ee.Number(ee.Algorithms.If(
      ee.Algorithms.IsEqual(rawPop, null),
      0,
      rawPop
    ));

    return f.set({
      'totalPop': totalPop,  // Explicitly set to ensure non-null
      'area_km2': areaKm2.max(0.05),
      'popDensity': totalPop.divide(areaKm2.max(0.05)),
      'cropland_pct': cropPct,
      'built_pct': builtPct
    });
  });
}

// ════════════════════════════════════════════════════════════════════════════════
// POPULATION HEAT RISK - IPCC AR6 Framework (Hazard × Exposure × Vulnerability)
// ════════════════════════════════════════════════════════════════════════════════
//
// Comprehensive heat risk combining temperature, population, and housing vulnerability
//
// Formula: Score = (H × E × V)^(1/3) × 100
//
// H (Hazard): LST_mean - Ward-mean LST temperature (P5-P95 normalized)
// E (Exposure): ln(totalPop + 1) - Log-transformed population (P5-P95 normalized)
// V (Vulnerability): informalHousingScore - Dense housing score (P5-P95 normalized)
//
// Log transformation for Exposure (E):
// - Handles wide population ranges (1,000 to 100,000+ residents per ward)
// - Prevents mega-wards from dominating scores purely due to population size
// - Balances contribution across small and large wards
//
// Vulnerability Components (3-factor geometric mean):
// - Building Density: GHSL Built Surface 2025 (% coverage)
// - Vegetation Deficit: 100 - normalized tree/grass cover (WorldCover)
// - Nightlight Dimness: 100 - normalized VIIRS nightlights (poor infrastructure)
//
// Geometric mean ensures balanced contribution from all three factors:
// - No single factor dominates the score
// - Accounts for heat (H), people exposed (E), and housing quality (V)
// - Aligns with IPCC AR6 risk framework
//
// Classification:
// - HIGH: Top 30% (≥70th percentile)
// - MEDIUM: Next 30% (40th-70th percentile)
// - LOW: Bottom 40% (<40th percentile)
//
// Resolution: Population summed on the native WorldPop grid (~93m), LST at 30m (built pixels)
// ════════════════════════════════════════════════════════════════════════════════

function calculatePopulationHeatRisk_v2(wards, lstWards, popWards, cityBoundary, cityConfig, sharedMetrics, informalHousingWards) {
  try {
    // ⚡ LAYER CACHE: cityStats is descriptive metadata never read downstream
    // (verified), so null is safe on the cached path.
    if (cityHasLayerCache(cityName)) {
      return {
        wards: ee.FeatureCollection(cacheAssetId(cityName, 'pop_wards')),
        cityStats: null
      };
    }
    // ═══════════════════════════════════════════════════════════════════
    // STEP 1: INPUT VALIDATION
    // ═══════════════════════════════════════════════════════════════════
    if (!wards || !lstWards || !popWards) {
      return { wards: createDefaultWardResults(wards), cityStats: null };
    }

    wards = ee.FeatureCollection(wards);
    lstWards = ee.FeatureCollection(lstWards);
    popWards = ee.FeatureCollection(popWards);  // Pre-computed population

    // Optional: Set default vulnerability if not provided
    informalHousingWards = informalHousingWards || wards.map(function(w) {
      return w.set('informalHousingScore', 50);  // Default moderate vulnerability
    });
    informalHousingWards = ee.FeatureCollection(informalHousingWards);

    // ═══════════════════════════════════════════════════════════════════
    // STEP 2: POPULATION ALREADY PRE-COMPUTED
    // ═══════════════════════════════════════════════════════════════════
    // popWards now comes pre-computed with totalPop and area_km2 from computeWardPopulation()
    // This eliminates redundant worldpop.reduceRegions calls across multiple layers

    // ═══════════════════════════════════════════════════════════════════
    // STEP 3: JOIN REQUIRED DATA (Fix 1: Selective joins - only properties we use)
    // ═══════════════════════════════════════════════════════════════════
    // Join only LST data (absolute temperature)
    var wardsWithData = joinWardResultsSelective(
      popWards, lstWards, 'WARD_NO',
      ['LST_mean', 'LST_max']  // Need mean and max LST for top ward identification
    );

    // Join vulnerability data (dense housing score)
    wardsWithData = joinWardResultsSelective(
      wardsWithData, informalHousingWards, 'WARD_NO',
      ['informalHousingScore']  // 3-component vulnerability score
    );

    // REMOVED: coolRoofWards join - builtFrac_mean not used in risk calculation
    // This removal allows Population Heat Risk and Cool Roof to run in parallel

    // ═══════════════════════════════════════════════════════════════════
    // STEP 4: COMPUTE PERCENTILES FOR NORMALIZATION
    // ═══════════════════════════════════════════════════════════════════
    // Calculate P5-P95 for H, E, V to ensure balanced contribution in geometric mean
    // Add log-transformed population for better scaling across wide population ranges
    var wardsWithLogPop = wardsWithData.map(function(w) {
      var pop = getNumber(w, 'totalPop', 0);  // Safe extraction with default
      var logPop = pop.add(1).log();  // ln(pop + 1) to handle zero population
      return w.set('logPop', logPop);
    });

    var percentiles = wardsWithLogPop
      .filter(ee.Filter.notNull(['LST_mean', 'logPop', 'informalHousingScore']))
      .reduceColumns({
        reducer: ee.Reducer.percentile([5, 95]).setOutputs(['lst_p5', 'lst_p95'])
          .combine(ee.Reducer.percentile([5, 95]).setOutputs(['logpop_p5', 'logpop_p95']), '', false)
          .combine(ee.Reducer.percentile([5, 95]).setOutputs(['vuln_p5', 'vuln_p95']), '', false),
        selectors: ['LST_mean', 'logPop', 'informalHousingScore']
      });

    var lstP5 = safeDictNumber(percentiles, 'lst_p5', 30);
    var lstP95 = safeDictNumber(percentiles, 'lst_p95', 45);
    var logPopP5 = safeDictNumber(percentiles, 'logpop_p5', 7);     // ln(~1000)
    var logPopP95 = safeDictNumber(percentiles, 'logpop_p95', 11);  // ln(~50000)
    var vulnP5 = safeDictNumber(percentiles, 'vuln_p5', 10);
    var vulnP95 = safeDictNumber(percentiles, 'vuln_p95', 80);

    var lstRange = lstP95.subtract(lstP5).max(1);
    var logPopRange = logPopP95.subtract(logPopP5).max(1);
    var vulnRange = vulnP95.subtract(vulnP5).max(1);

    // ═══════════════════════════════════════════════════════════════════
    // STEP 5: CALCULATE IPCC AR6 RISK SCORE (H × E × V)
    // ═══════════════════════════════════════════════════════════════════
    // IPCC framework: Risk = (Hazard × Exposure × Vulnerability)^(1/3)
    // Geometric mean ensures balanced contribution from all three factors

    var scoredWards = wardsWithLogPop.map(function(ward) {
      // Extract values with safe defaults
      var totalPop = getNumber(ward, 'totalPop', 0);
      var logPop = getNumber(ward, 'logPop', 0);  // Log-transformed population
      var lstMean = getNumber(ward, 'LST_mean', 35);  // Absolute temperature (default 35°C)
      var areaKm2 = getNumber(ward, 'area_km2', 0.05);
      var vulnerabilityScore = getNumber(ward, 'informalHousingScore', 50);  // Default moderate

      // Normalize components to 0-1 range with positive floor (0.01 minimum)
      // This ensures balanced contribution and prevents zeros in geometric mean
      // Extra safety: ensure values are not null before operations
      var H = ee.Number(lstMean).subtract(lstP5).divide(lstRange).max(0.01);  // Hazard: Temperature
      var E = ee.Number(logPop).subtract(logPopP5).divide(logPopRange).max(0.01); // Exposure: ln(population)
      var V = ee.Number(vulnerabilityScore).subtract(vulnP5).divide(vulnRange).max(0.01); // Vulnerability: Dense housing

      // IPCC AR6 formula: Risk = (H × E × V)^(1/3) × 100
      // Geometric mean (cube root) ensures no single factor dominates
      var riskScore = H.multiply(E).multiply(V)
        .pow(ee.Number(1).divide(3))  // Cube root for 3 components
        .multiply(100);  // Scale to 0-100

      // Set all properties
      return ward.set({
        'lstMean': lstMean,
        'riskScore': riskScore,
        'totalPop': totalPop,
        'areaKm2': areaKm2,
        'popDensity': totalPop.divide(areaKm2),
        'vulnerabilityScore': vulnerabilityScore,
        'hazardComponent': H.multiply(100),     // For diagnostics
        'exposureComponent': E.multiply(100),   // For diagnostics
        'vulnerabilityComponent': V.multiply(100), // For diagnostics
        'priority_score': riskScore,
        'popHeatScore': riskScore
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // STEP 6: DAMPEN AGRICULTURAL WARDS BEFORE CLASSIFICATION
    // ═══════════════════════════════════════════════════════════════════
    // Agricultural wards get their riskScore multiplied down so they
    // naturally fall into the bottom 40% (Low) after percentile classification.
    // All wards remain in the distribution — no nulls, no excluded category.

    var CROPLAND_THRESHOLD = 50;  // wards with >50% cropland are dampened
    var MIN_BUILT_THRESHOLD = 10; // wards with <10% built are dampened

    var scoredWardsDampened = scoredWards.map(function(ward) {
      var cropPct = getNumber(ward, 'cropland_pct', 0);
      var builtPct = getNumber(ward, 'built_pct', 100);

      var isAgricultural = cropPct.gt(CROPLAND_THRESHOLD)
        .or(builtPct.lt(MIN_BUILT_THRESHOLD));

      var riskScore = getNumber(ward, 'riskScore', 0);

      // Multiply risk score by 0.1 for agricultural wards
      // This pushes them well below P40, ensuring they land in Low
      var dampedScore = ee.Number(ee.Algorithms.If(
        isAgricultural,
        riskScore.multiply(0.1),
        riskScore
      ));

      return ward.set({
        'riskScore': dampedScore,
        'priority_score': dampedScore,
        'popHeatScore': dampedScore
      });
    });

    // ═══════════════════════════════════════════════════════════════════
    // STEP 7: CLASSIFY INTO LOW/MEDIUM/HIGH CATEGORIES
    // ═══════════════════════════════════════════════════════════════════
    var finalWards = addPriorityByPercentilesKeepAll(
      scoredWardsDampened,
      'riskScore',
      40,
      70
    );

    // ═══════════════════════════════════════════════════════════════════
    // STEP 7.5: ADD TOP LST WARDS TO HIGH PRIORITY
    // ═══════════════════════════════════════════════════════════════════
    // Per Chief Heat Officer Ahmedabad: Add the 3-4 physically hottest
    // wards to High priority, regardless of composite risk score
    var TOP_LST_WARDS_TO_ADD = 4;  // Add top 4 hottest wards

    // Sort wards by LST_mean (descending) and get top N
    var wardsSortedByLST = finalWards.sort('LST_mean', false);  // false = descending
    var topLSTWards = wardsSortedByLST.limit(TOP_LST_WARDS_TO_ADD);

    // Get ward IDs of top LST wards
    var topLSTWardIDs = topLSTWards.aggregate_array('WARD_NO');

    // Promote these wards to High priority
    var finalWardsWithLSTOverride = finalWards.map(function(ward) {
      var wardNo = ward.get('WARD_NO');
      var currentLevel = ward.get('priority_level');
      var lstMean = getNumber(ward, 'LST_mean', 0);

      // Check if this ward is in the top LST list
      var isTopLSTWard = topLSTWardIDs.contains(wardNo);

      // Promote to High if in top LST list
      var finalLevel = ee.String(ee.Algorithms.If(
        isTopLSTWard,
        'High',
        currentLevel
      ));

      // Track override for transparency
      var wasNotAlreadyHigh = ee.String(currentLevel).compareTo('High').neq(0);
      // Use ee.Algorithms.If for boolean logic instead of .and()
      var wasOverridden = ee.Algorithms.If(
        isTopLSTWard,
        wasNotAlreadyHigh,
        0
      );
      var overrideReason = ee.String(ee.Algorithms.If(
        wasOverridden,
        ee.String('Top LST ward: ').cat(lstMean.format('%.1f')).cat('°C'),
        ''
      ));

      return ward.set({
        'priority_level': finalLevel,
        'top_lst_override': wasOverridden,
        'override_reason': overrideReason
      });
    });

    // Use overridden wards as final result
    finalWards = finalWardsWithLSTOverride;

    // ═══════════════════════════════════════════════════════════════════
    // STEP 8: RETURN RESULTS WITH METADATA
    // ═══════════════════════════════════════════════════════════════════
    var cityStats = ee.Dictionary({
      'methodology': 'IPCC AR6 Framework (Hazard × Exposure × Vulnerability)',
      'formula': 'Score = (H × E × V)^(1/3) × 100 (geometric mean)',
      'hazard_H': 'LST_mean - Ward-mean LST temperature (P5-P95 normalized)',
      'exposure_E': 'ln(population + 1) - Log-transformed population (P5-P95 normalized)',
      'vulnerability_V': 'Dense housing score (3-component: density × veg deficit × nightlights)',
      'classification': 'Low <40%, Medium 40-70%, High >70%',
      'resolution': 'native-grid (~93m) WorldPop population aggregation',
      'note': 'Standard H×E×V framework with log-transformed population for balanced scaling',
      'vulnerability_components': '(Density × VegDeficit × Dimness)^(1/3) from GHSL + WorldCover + VIIRS'
    });

    return {
      wards: finalWards,
      cityStats: cityStats
    };

  } catch (e) {
    return {
      wards: createDefaultWardResults(wards),
      cityStats: null
    };
  }
}
// ════════════════════════════════════════════════════════════════════════════════
// COOL ROOF PRIORITY - IPCC AR6 Framework (Cleaned Version)
// ════════════════════════════════════════════════════════════════════════════════
//
// Formula: Score = (H × E × V)^(1/3) × 100
//
// H (HAZARD): LST_mean - Land Surface Temperature from lstWards
// E (EXPOSURE): Built fraction at ward level
// V (VULNERABILITY): Albedo deficit (1 - normalized albedo) on built surfaces
//
// Classification:
// - HIGH: Top 30% (≥70th percentile)
// - MEDIUM: Next 30% (40th-70th percentile)
// - LOW: Bottom 40% (<40th percentile)
//
// Resolution: 10m for small cities, 30m for large cities (>1400 km²)
// No built fraction threshold - all wards treated equally
// ════════════════════════════════════════════════════════════════════════════════

function calculateCoolRoofPriority(wards, lst, lulc, albedo, popWards, cityConfig, ndvi, lstWards, cityBoundary, cityMeanAlbedo, cityMeanRoofAlbedo) {
  // ⚡ LAYER CACHE: finished ward table with scores + priority_level.
  if (cityHasLayerCache(cityName)) {
    return ee.FeatureCollection(cacheAssetId(cityName, 'coolroof_wards'));
  }

  // Configure scale parameters
  // MEMORY FIX: Use 30m for all cities since built mask is resampled to 30m anyway
  // Small cities at 10m process 9x more pixels with no accuracy benefit
  var SCALE = 30;
  var CRS = 'EPSG:4326';
  var TARGET_ALBEDO = 0.60;

  cityConfig = cityConfig || {};

  // ═══════════════════════════════════════════════════════════════════
  // STEP 1: PREPARE BUILT AND ALBEDO LAYERS
  // ═══════════════════════════════════════════════════════════════════

  // Extract built areas from land cover
  var built10m = lulc.eq(50).unmask(0);

  // Ensure albedo has valid data
  var albedoLayer = albedo ? albedo : ee.Image.constant(0.20);

  // Resample built mask to fixed 30m resolution
  // CRITICAL FIX: Use explicit EPSG:4326 instead of deferred .projection()
  // which can cause memory explosion when albedoLayer is conditional
  var built30m = built10m.reproject({
    crs: 'EPSG:4326',
    scale: 30
  });

  // ═══════════════════════════════════════════════════════════════════
  // STEP 2: CALCULATE WARD-LEVEL STATISTICS
  // ═══════════════════════════════════════════════════════════════════

  // Create weighted albedo for built areas. Only two bands are needed: the
  // combined sum+mean reducer yields built_sum (the weight denominator) AND
  // built_mean (the built fraction) from the single 'built' band, and the
  // built-weighted albedo is albedoW_sum / built_sum. The former 'builtW'
  // duplicate and the never-read 'builtAlbedo' band cost 40% of this
  // reduction's memory for no output (verified identical sums, Oct 2026).
  var albedoWeighted = albedoLayer.multiply(built30m).rename('albedoW');

  // Combine bands for efficient processing
  var combinedBands = ee.Image.cat([
    albedoWeighted,
    built30m.rename('built')
  ]);

  // Population is NOT summed here. Summing the ~93 m WorldPop head-count
  // raster at this function's 30 m scale sampled every source pixel ~11
  // times and inflated each ward's population by that factor; the shared
  // ward table (computeWardPopulation) is joined in below instead.

  // Dark BUILT SURFACE area: pixels where albedo < 0.20 AND WorldCover built class
  // IMPORTANT: This includes ALL impervious surfaces (rooftops + roads + courtyards + paved areas)
  // NOT rooftops alone - satellite cannot distinguish roofs from other dark impervious surfaces
  // Sentinel-2 albedo is at 10m resolution so each pixel = 100m²
  // Multiply by pixelArea() to get m² per pixel, sum gives total dark built surface area per ward
  // Dark = albedo < 0.15, matching the app's own Surface Albedo scale where
  // 0.10-0.15 is the dark asphalt / dark-roof band. The previous <0.20 cut
  // also swept in ordinary concrete and traditional roofs (0.15-0.25 band),
  // so "dark area" was close to ALL built area and the derived rooftop and
  // building numbers were severely inflated.
  var darkBuiltPixels = albedoLayer.lt(0.15)
    .and(built30m)
    .multiply(ee.Image.pixelArea())
    .rename('darkBuiltArea');

  combinedBands = combinedBands.addBands(darkBuiltPixels);

  // Calculate statistics for each ward
  var wardStats = combinedBands.reduceRegions({
    collection: wards,
    reducer: ee.Reducer.sum()
      .combine(ee.Reducer.mean(), '', true),
    scale: SCALE,
    crs: CRS,
    tileScale: 16,  // Use 16 for all cities for better parallelization
    maxPixelsPerRegion: 1e8  // Reduced from 1e9 to prevent memory overflow
  });

  // Ward population from the shared native-grid sum (same source every layer uses)
  if (popWards) {
    wardStats = joinWardResultsSelective(wardStats, popWards, 'WARD_NO', ['totalPop']);
  }

  // Compute built-weighted albedo with positive floors
  wardStats = wardStats.map(function(f) {
    var albedoWsum = getNumber(f, 'albedoW_sum', 0.05);
    var builtWsum = getNumber(f, 'built_sum', 0.05).max(0.05);
    var builtAlbedo_mean = albedoWsum.divide(builtWsum).clamp(0.05, 1);
    var builtFrac_mean = getNumber(f, 'built_mean', 0.05).clamp(0.05, 1);
    var totalPop = getNumber(f, 'totalPop', 1).max(1);

    // Dark built surface area (includes roofs + roads + courtyards + paved areas)
    var darkBuiltArea_m2 = getNumber(f, 'darkBuiltArea_sum', 0);

    // Estimate rooftop area as 50% of total dark built surface
    // (Roofs typically 40-60% of built surface; roads, courtyards, paved areas are remainder)
    var ROOF_FRACTION = 0.50;
    var estimatedRoofArea_m2 = darkBuiltArea_m2.multiply(ROOF_FRACTION);

    // Building count range (two bounds, no single point estimate)
    // Based on ESTIMATED rooftop area only (50% of dark built surface)
    // Lower bound: 120m² median rooftop, planned residential areas (URDPFI 2014 plot norms)
    // Upper bound: 30m² median rooftop, dense/old city (Census of India 2011 urban housing data)
    var buildingCountMin = estimatedRoofArea_m2.divide(120).ceil();
    var buildingCountMax = estimatedRoofArea_m2.divide(30).ceil();
    // Single indicative estimate at a blended 70 m² median rooftop (between
    // the 30 m² dense/old-city and 120 m² planned-residential bounds). The
    // 4x-wide min-max span alone was unusable for planning.
    var buildingCountEst = estimatedRoofArea_m2.divide(70).ceil();

    return f.set({
      'builtAlbedo_mean': builtAlbedo_mean,
      'builtFrac_mean': builtFrac_mean,
      'w_sum': builtWsum,
      'totalPop': totalPop,
      'darkBuiltArea_m2': darkBuiltArea_m2,  // Total dark built surface (all impervious)
      'estimatedRoofArea_m2': estimatedRoofArea_m2,  // Estimated roofs only (50% of total)
      'buildingCountMin': buildingCountMin,
      'buildingCountMax': buildingCountMax,
      'buildingCountEst': buildingCountEst
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // STEP 3: JOIN LST DATA
  // ═══════════════════════════════════════════════════════════════════

  var wardsWithLST;
  if (lstWards) {
    // Join LST data using selective join to avoid property bloat
    wardsWithLST = joinWardResultsSelective(wardStats, lstWards, 'WARD_NO', ['LST_mean']);
  } else {
    // Default LST value if no data
    wardsWithLST = wardStats.map(function(f) {
      return f.set('LST_mean', 35);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // STEP 4: FILTER VALID WARDS
  // ═══════════════════════════════════════════════════════════════════

  var validWards = wardsWithLST.filter(ee.Filter.and(
    ee.Filter.notNull(['builtFrac_mean', 'builtAlbedo_mean', 'LST_mean']),
    ee.Filter.gt('w_sum', 1e-3)  // Ensure reliable data
  ));

  var nValid = validWards.size();

  // ═══════════════════════════════════════════════════════════════════
  // STEP 5: CALCULATE NORMALIZATION PARAMETERS
  // ═══════════════════════════════════════════════════════════════════

  var result = ee.Algorithms.If(
    nValid.eq(0),
    // No valid data - return default values
    wards.map(function(f) {
      return f.set({
        'coolRoofPriorityScore': 0,
        'priority_level': 'Low',
        'priority_score': 0,
        'builtFrac_ward': 0,
        'builtAlbedo_mean': 0.20
      });
    }),
    // Process valid wards
    ee.FeatureCollection(computeCoolRoofPriority(wardsWithLST, validWards, nValid, TARGET_ALBEDO))
  );

  return ee.FeatureCollection(result);
}

// Helper function to calculate cool roof scores
function computeCoolRoofPriority(allWards, validWards, nValid, TARGET_ALBEDO) {

  // ═══════════════════════════════════════════════════════════════════
  // CALCULATE P5-P95 PERCENTILES
  // ═══════════════════════════════════════════════════════════════════

  // LST percentiles
  var lstStats = ee.Dictionary(validWards.reduceColumns(
    ee.Reducer.percentile([5, 95]).setOutputs(['p5', 'p95']),
    ['LST_mean']
  ));
  var lstP5 = safeDictNumber(lstStats, 'p5', 30);
  var lstP95 = safeDictNumber(lstStats, 'p95', 50);
  var lstRange = lstP95.subtract(lstP5).max(1);

  // Built fraction percentiles
  var builtStats = ee.Dictionary(validWards.reduceColumns(
    ee.Reducer.percentile([5, 95]).setOutputs(['p5', 'p95']),
    ['builtFrac_mean']
  ));
  var builtP5 = safeDictNumber(builtStats, 'p5', 0.05);
  var builtP95 = safeDictNumber(builtStats, 'p95', 0.80);
  var builtRange = builtP95.subtract(builtP5).max(0.1);

  // Albedo percentiles
  var albedoStats = ee.Dictionary(validWards.reduceColumns(
    ee.Reducer.percentile([5, 95]).setOutputs(['p5', 'p95']),
    ['builtAlbedo_mean']
  ));
  var albedoP5 = safeDictNumber(albedoStats, 'p5', 0.10);
  var albedoP95 = safeDictNumber(albedoStats, 'p95', 0.30);
  var albedoRange = albedoP95.subtract(albedoP5).max(0.05);

  // ═══════════════════════════════════════════════════════════════════
  // CALCULATE HEV SCORES
  // ═══════════════════════════════════════════════════════════════════

  var scoredWards = allWards.map(function(f) {
    // Extract values with appropriate positive bounds
    var builtFrac = getNumber(f, 'builtFrac_mean', 0.05).clamp(0.05, 1);
    var albedoMean = getNumber(f, 'builtAlbedo_mean', 0.20).clamp(0.05, 1);
    var lstMean = getNumber(f, 'LST_mean', 35).max(1);  // LST should be positive (Celsius), min 1°C
    var wsum = getNumber(f, 'w_sum', 0.05).max(0.05);

    // Calculate H (Hazard): Normalized LST with positive floor
    var H = lstMean.subtract(lstP5).divide(lstRange).max(0.05);

    // Calculate E (Exposure): Normalized built fraction with positive floor
    var E = builtFrac.subtract(builtP5).divide(builtRange).max(0.05);

    // Calculate V (Vulnerability): Albedo deficit (1 - normalized albedo)
    var albedoNorm = albedoMean.subtract(albedoP5).divide(albedoRange).clamp(0, 1);
    var V = ee.Number(1).subtract(albedoNorm).clamp(0.05, 1);

    // Calculate Cool Roof Priority Score
    var hasGoodData = wsum.gt(1e-3);
    var rawScore = H.multiply(E).multiply(V)
      .pow(ee.Number(1).divide(3))
      .multiply(100);

    var coolRoofScore = ee.Number(ee.Algorithms.If(
      hasGoodData,
      rawScore.max(0.05),  // Ensure positive score
      0.05  // Minimum positive score
    ));

    // Calculate intervention metrics with appropriate positive floors
    var wardArea = ee.Number(f.geometry().area(1)).divide(1e6).max(0.05);  // Min 0.05 km²
    var builtArea = wardArea.multiply(builtFrac).max(0.05);
    var roofArea = builtArea.multiply(0.6).max(0.05);  // 60% roof assumption
    var albedoGap = ee.Number(TARGET_ALBEDO).subtract(albedoMean).max(0.05);
    var potentialCooling = albedoGap.multiply(15).divide(0.45).max(0.05);

    return f.set({
      'hazard_H': H,
      'exposure_E': E,
      'vulnerability_V': V,
      'coolRoofPriorityScore': coolRoofScore,
      'priority_score': coolRoofScore,
      'builtFrac_ward': builtFrac,
      'builtAlbedo_mean': albedoMean,
      'LST_mean_ward': lstMean,
      'wardArea_km2': wardArea,
      'builtArea_km2': builtArea,
      'roofArea_km2': roofArea,
      'albedoGap': albedoGap,
      'potentialCooling_C': potentialCooling,
      'eligible': ee.Number(1),
      'coolroof_data_ok': hasGoodData
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // CLASSIFY INTO LOW/MEDIUM/HIGH
  // ═══════════════════════════════════════════════════════════════════

  var withScores = scoredWards.filter(ee.Filter.gt('coolRoofPriorityScore', 0));
  var withoutScores = scoredWards.filter(ee.Filter.lte('coolRoofPriorityScore', 0));

  // Calculate classification thresholds
  var scoreStats = ee.Dictionary(withScores.reduceColumns(
    ee.Reducer.percentile([40, 70]).setOutputs(['p40', 'p70']),
    ['coolRoofPriorityScore']
  ));
  var scoreP40 = safeDictNumber(scoreStats, 'p40', 30);
  var scoreP70 = safeDictNumber(scoreStats, 'p70', 60);

  // Classify wards with scores
  var classifiedWithScores = withScores.map(function(f) {
    var score = getNumber(f, 'coolRoofPriorityScore', 0.05);
    var level = ee.String(ee.Algorithms.If(
      score.gte(scoreP70), 'High',
      ee.Algorithms.If(score.gte(scoreP40), 'Medium', 'Low')
    ));
    return f.set('priority_level', level);
  });

  // Set low priority for wards without scores
  var classifiedWithoutScores = withoutScores.map(function(f) {
    return f.set('priority_level', 'Low');
  });

  return classifiedWithScores.merge(classifiedWithoutScores);
}

// TRUE "lowest canopy coverage in built-up areas"
// - No distance transform (fast!)
// - Works on 100m grid
// - Cropland TRULY excluded (masked, not converted to 0)
// - Urban-only via built fraction + cropland dominance guards
// - Pixel-level greening need scoring (not ward-mean product)
// ════════════════════════════════════════════════════════════════════════════════
// TREE PLANTING PRIORITY - IPCC-Aligned 3-Factor Scoring (v2.0)
// ════════════════════════════════════════════════════════════════════════════════
//
// METHODOLOGY: Priority Score = (Canopy Deficit × Built Intensity × Heat Exposure)^(1/3) × 100
//
// FIXES FROM v1.0:
// 1. Absolute area bias → Relative deficit from 20% target
// 2. No heat integration → Heat added as third factor (H)
// 3. Confusing greeningNeed_m2 → Clear IPCC components (V, E, H)
// 4. Size-dependent scoring → City-normalized percentiles
// 5. Built fraction correlation → Exposed population (people in low-canopy areas)
//
// SCIENTIFIC BASIS:
//   - Target: 20% urban canopy (MoHUA planning standard, 18% healthy threshold)
//   - Deficit: (Target - Current) / Target, not absolute area
//   - Exposure: ln(count of people in <20% canopy pixels) - balances count vs rate
//   - Geometric mean: All factors must be elevated for high priority
//   - City-normalized: Allows cross-ward comparison
// ════════════════════════════════════════════════════════════════════════════════

function calculateTreePlantingPriority_LowCanopy(wards, popWards, urbanData, cityBoundary, lstWards) {
  try {
    // ⚡ LAYER CACHE: finished ward table with scores + priority_level.
    if (cityHasLayerCache(cityName)) {
      return ee.FeatureCollection(cacheAssetId(cityName, 'tree_wards'));
    }

    // Validate inputs
    if (!wards || !urbanData || !cityBoundary) {
      return createDefaultWardResults(wards || ee.FeatureCollection([]));
    }

    // ────────────────────────────────────────────────────────────────────────
    // CONFIGURATION
    // ────────────────────────────────────────────────────────────────────────
    var TARGET_CANOPY_PCT = 20;      // MoHUA planning standard (18% healthy threshold) for Indian cities (%)
    // REMOVED: MIN_BUILT_FRAC - now all wards are considered
    var MIN_CANOPY_PIXELS = 10;      // Minimum valid pixels for reliable estimate
    var CANOPY_CAP_FOR_HIGH = 20;    // Wards above this can't be "High" priority (MoHUA standard)

    // Projections and scales
    var POP_CRS = 'EPSG:4326';
    var POP_SCALE = 100;             // Analysis scale

    // ✅ CHALLENGE 2 FIX: Use pre-computed masks from urbanData (cached in processUrbanLayers)
    // This eliminates redundant resampling and projection chaos
    var builtFrac100 = urbanData.builtFrac100;
    var cropFrac100 = urbanData.cropFrac100;
    var canopyFrac100 = urbanData.canopyFrac100;
    var worldpop = urbanData.population;

    // Process canopy for all areas, not just urban
    var canopyUrban = canopyFrac100;  // No masking by built fraction
    var builtUrban = builtFrac100;  // No masking - removed urbanMask100 reference

    // Low-canopy mask: For Exposure = count people in low-canopy pixels
    var LOW_CANOPY_THRESHOLD = 0.20;  // People below 20% canopy are "exposed"
    var lowCanopyMask = canopyFrac100.lt(LOW_CANOPY_THRESHOLD);
    var popInLowCanopy = worldpop ? worldpop.updateMask(lowCanopyMask).rename('popLowCanopy') : null;

    // ────────────────────────────────────────────────────────────────────────
    // STEP 3: WARD-LEVEL AGGREGATION
    // ────────────────────────────────────────────────────────────────────────

    // Combine bands for single reduceRegions call (excluding population which is pre-computed)
    var combinedBands = builtUrban.rename('builtFrac')
      .addBands(canopyUrban.rename('canopyFrac'));

    // Only add low-canopy population for tree planting exposure (special metric)
    if (popInLowCanopy) {
      combinedBands = combinedBands.addBands(popInLowCanopy.unmask(0));
    }

    // Single reduceRegions call (no total population - using pre-computed)
    var wardStats = combinedBands.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.mean()
        .combine(ee.Reducer.stdDev(), '', true)
        .combine(ee.Reducer.min(), '', true)
        .combine(ee.Reducer.max(), '', true)
        .combine(ee.Reducer.count(), '', true)
        .combine(ee.Reducer.sum(), '', true),
      // Native WorldPop grid so popLowCanopy_sum counts each source pixel
      // once (see computeWardPopulation). The 100 m fraction bands are only
      // resampled onto that ~93 m lattice, which leaves their means unchanged
      // to rounding.
      crs: worldpop ? worldpop.projection() : ee.Projection(POP_CRS).atScale(POP_SCALE),
      tileScale: 16,  // ✅ PERFORMANCE: Increased from 8 to 16 for faster parallel processing
      maxPixelsPerRegion: 1e8
    });

    // Join pre-computed population data
    if (popWards) {
      wardStats = joinWardResultsSelective(wardStats, popWards, 'WARD_NO', ['totalPop']);
    }

    // Join LST data if available (lstWards has ward-level heat metrics)
    if (lstWards) {
      wardStats = joinWardResults(wardStats, lstWards, 'WARD_NO', 'heat');
    }

    // ────────────────────────────────────────────────────────────────────────
    // STEP 1: REMOVED - No longer filtering by built fraction
    // ────────────────────────────────────────────────────────────────────────
    // All wards are now considered for analysis regardless of built fraction
    // NOTE: Zero-canopy wards remain HIGH PRIORITY for tree planting
    // wardStats = wardStats.filter(ee.Filter.gte('builtFrac_mean', MIN_BUILT_FRAC));  // REMOVED

    // ────────────────────────────────────────────────────────────────────────
    // STEP 4: COMPUTE CITY-WIDE PERCENTILES FOR NORMALIZATION
    // ────────────────────────────────────────────────────────────────────────

    // All wards already filtered in Step 1 by built ≥ 20% and pixel count ≥ 10
    var eligibleForPercentiles = wardStats;

    // LST percentiles (for hazard normalization) - use joined lstWards data
    var lstP5 = ee.Number(30);  // Default
    var lstP95 = ee.Number(50);
    if (lstWards) {
      var lstPctCalc = ee.Dictionary(eligibleForPercentiles
        .filter(ee.Filter.notNull(['LST_mean']))
        .reduceColumns(
          ee.Reducer.percentile([5, 95]).setOutputs(['p5', 'p95']),
          ['LST_mean']
        ));
      lstP5 = safeDictNumber(lstPctCalc, 'p5', 30);
      lstP95 = safeDictNumber(lstPctCalc, 'p95', 50);
    }

    // ────────────────────────────────────────────────────────────────────────
    // STEP 5: COMPUTE PRIORITY SCORES (IPCC 3-Factor)
    // ────────────────────────────────────────────────────────────────────────

    var TARGET_CANOPY_FRAC = TARGET_CANOPY_PCT / 100;  // Convert to fraction

    var scoredWards = wardStats.map(function(f) {
      // Raw values from combined reducer (note: _mean suffix from mean reducer)
      var builtFrac = getNumber(f, 'builtFrac_mean', 0).clamp(0, 1);
      var builtFrac_stdDev = getNumber(f, 'builtFrac_stdDev', 0);
      var builtFrac_min = getNumber(f, 'builtFrac_min', 0);
      var builtFrac_max = getNumber(f, 'builtFrac_max', 1);
      var canopyFrac = getNumber(f, 'canopyFrac_mean', 0).clamp(0, 1);
      var canopyFrac_stdDev = getNumber(f, 'canopyFrac_stdDev', 0);
      var canopyFrac_min = getNumber(f, 'canopyFrac_min', 0);
      var canopyFrac_max = getNumber(f, 'canopyFrac_max', 1);
      var canopyCount = getNumber(f, 'canopyFrac_count', 0);
      var totalPop = getNumber(f, 'totalPop', 0);  // Using pre-computed population
      var popLowCanopy = getNumber(f, 'popLowCanopy_sum', 0);

      // Get LST from joined lstWards (if available)
      var lstMean = getNumber(f, 'LST_mean', 35);

      // Convert to percentages for display
      var canopyPctVal = canopyFrac.multiply(100);
      var builtPctVal = builtFrac.multiply(100);

      // ──────────────────────────────────────────────────────────────────────
      // ELIGIBILITY CHECK
      // ──────────────────────────────────────────────────────────────────────
      // All wards already filtered in Step 1 by built ≥ 20% and pixel count ≥ 10
      var eligible01 = ee.Number(1);

      // ──────────────────────────────────────────────────────────────────────
      // COMPONENT 1: CANOPY DEFICIT (Vulnerability)
      // Deficit = (Target - Current) / Target, clamped to [0, 1]
      // If current ≥ target, deficit = 0 (no intervention needed)
      // ──────────────────────────────────────────────────────────────────────
      var deficit = ee.Number(TARGET_CANOPY_FRAC).subtract(canopyFrac)
        .divide(TARGET_CANOPY_FRAC)
        .clamp(0, 1);

      // Apply floor to prevent log(0) in geometric mean
      var deficitNorm = deficit.max(0.01);

      // ──────────────────────────────────────────────────────────────────────
      // COMPONENT 2: EXPOSED POPULATION (Exposure)
      // Use ln(population in low-canopy areas) directly - no percentile normalization
      // Log transformation already balances small and large wards appropriately:
      //   100 people → ln(101) = 4.6
      //   10,000 people → ln(10,001) = 9.2
      //   100,000 people → ln(100,001) = 11.5
      // This removes the systematic penalty against small wards with high tree need
      // ──────────────────────────────────────────────────────────────────────
      var popLog = popLowCanopy.add(1).log();  // ln(pop + 1) to handle zero
      var exposedNorm = popLog.max(0.01);  // Simple floor to prevent zero

      // ──────────────────────────────────────────────────────────────────────
      // COMPONENT 3: HEAT EXPOSURE (Hazard)
      // Hotter areas = more cooling benefit from trees
      // Normalized 0-1 using city percentiles
      // ──────────────────────────────────────────────────────────────────────
      var lstRange = lstP95.subtract(lstP5).max(1);
      var heatNorm = lstMean.subtract(lstP5).divide(lstRange).clamp(0.01, 1.0);

      // ──────────────────────────────────────────────────────────────────────
      // PRIORITY SCORE: Geometric mean of 3 components
      // Score = (Deficit × ExposedPop × Heat)^(1/3) × 100
      // ──────────────────────────────────────────────────────────────────────
      var rawScore = deficitNorm.multiply(exposedNorm).multiply(heatNorm)
        .pow(ee.Number(1).divide(3))
        .multiply(100);

      // Set score to null for ineligible wards
      var priorityScore = ee.Number(ee.Algorithms.If(eligible01, rawScore, null));

      // ──────────────────────────────────────────────────────────────────────
      // RESOURCE PLANNING METRICS (for policy outputs)
      // ──────────────────────────────────────────────────────────────────────
      var wardArea_ha = f.geometry().area(1).divide(10000);
      var wardArea_km2 = wardArea_ha.divide(100);
      var builtArea_ha = wardArea_ha.multiply(builtFrac);

      // Canopy MISSING in the built-up area, in hectares: built ha × the
      // shortfall below the 20% target. The previous builtArea × deficit used
      // the RELATIVE shortfall ((20% − canopy) / 20%), a 0-1 index rather than
      // an area, which overstated the hectares by 1/0.20 = 5x.
      var canopyShortfall = ee.Number(TARGET_CANOPY_FRAC).subtract(canopyFrac).max(0);
      var canopyDeficit_ha = builtArea_ha.multiply(canopyShortfall);

      // Trees that would close the gap outright at the 400/ha norm (25 m²
      // mature crown each). The plantable fraction, saplings and cost depend
      // on the priority tier and are computed after classification (STEP 6)
      // so the per-ward table reconciles with the panel for every tier.
      var TREES_PER_HA = ee.Number(RESOURCE_CONFIG.tree.treesPerPlantableHa);
      var treesToCloseGap = canopyDeficit_ha.multiply(TREES_PER_HA).ceil();

      // Urgency classification
      var greeningUrgency = ee.String(
        ee.Algorithms.If(canopyPctVal.lt(5), 'CRITICAL',
        ee.Algorithms.If(canopyPctVal.lt(10), 'SEVERE',
        ee.Algorithms.If(canopyPctVal.lt(15), 'HIGH',
        ee.Algorithms.If(canopyPctVal.lt(20), 'MODERATE', 'ADEQUATE'))))
      );

      // Derived metrics for canopy and built fraction
      var canopyFrac_range = canopyFrac_max.subtract(canopyFrac_min);
      var canopyFrac_cv = canopyFrac_stdDev.divide(canopyFrac.max(0.01)).multiply(100);
      var builtFrac_cv = builtFrac_stdDev.divide(builtFrac.max(0.01)).multiply(100);

      return f.set({
        // Core metrics
        'treeCanopyFracUrban': ee.Algorithms.If(eligible01, canopyFrac, null),
        'treeCanopyPctUrban': ee.Algorithms.If(eligible01, canopyPctVal, null),
        'canopyFrac_mean': canopyFrac,
        'canopyFrac_stdDev': canopyFrac_stdDev,
        'canopyFrac_cv': canopyFrac_cv,
        'canopyFrac_min': canopyFrac_min,
        'canopyFrac_max': canopyFrac_max,
        'canopyFrac_range': canopyFrac_range,
        'builtFrac_ward': builtFrac,
        'builtFrac_mean': builtFrac,
        'builtPct': builtPctVal,
        'builtFrac_stdDev': builtFrac_stdDev,
        'builtFrac_cv': builtFrac_cv,
        'builtFrac_min': builtFrac_min,
        'builtFrac_max': builtFrac_max,
        'nCanopyPix': canopyCount,
        'totalPop': totalPop,
        'popInLowCanopy': popLowCanopy,  // Count of people in pixels with <20% canopy

        // Component scores (for diagnostics)
        'deficitNorm': ee.Algorithms.If(eligible01, deficitNorm, null),
        'exposedNorm': ee.Algorithms.If(eligible01, exposedNorm, null),
        'heatNorm': ee.Algorithms.If(eligible01, heatNorm, null),
        'lstMean': lstMean,

        // Green access score (inverted canopy for legacy compatibility)
        'greenAccessScore': ee.Algorithms.If(eligible01, deficit.multiply(100), null),

        // Priority score
        'priority_score': priorityScore,
        'eligible_green': eligible01,

        // Resource planning
        'currentCanopy_pct': ee.Algorithms.If(eligible01, canopyPctVal, null),
        'targetCanopy_pct': ee.Algorithms.If(eligible01, TARGET_CANOPY_PCT, null),
        'canopyDeficit_ppt': ee.Algorithms.If(eligible01, deficit.multiply(100), null),
        'canopyDeficit_ha': ee.Algorithms.If(eligible01, canopyDeficit_ha, null),
        'treesToCloseGap': ee.Algorithms.If(eligible01, treesToCloseGap, null),
        'greeningUrgency': ee.Algorithms.If(eligible01, greeningUrgency, null),
        'wardArea_ha': wardArea_ha,
        'wardArea_km2': wardArea_km2
      });
    });

    // ────────────────────────────────────────────────────────────────────────
    // STEP 6: PERCENTILE-BASED CLASSIFICATION
    // ────────────────────────────────────────────────────────────────────────

    // All wards are eligible (filtered in Step 1)
    // Get percentiles from all scored wards
    var scorePctCalc = ee.Dictionary(scoredWards
      .filter(ee.Filter.notNull(['priority_score']))
      .reduceColumns(
        ee.Reducer.percentile([40, 70]).setOutputs(['p40', 'p70']),
        ['priority_score']
      ));

    var scoreP40 = safeDictNumber(scorePctCalc, 'p40', 30);
    var scoreP70 = safeDictNumber(scorePctCalc, 'p70', 60);

    // Classify all wards
    var finalWards = scoredWards.map(function(f) {
      var score = getNumber(f, 'priority_score', 0);
      var canopyPctVal = getNumber(f, 'treeCanopyPctUrban', 0);

      // Classification logic:
      // - High: Top 30% by score (canopy <20% is already guaranteed by deficit formula)
      // - Medium: 40-70th percentile
      // - Low: Bottom 40%

      var isHighScore = score.gte(scoreP70);
      var isMedScore = score.gte(scoreP40);

      var level = ee.String(ee.Algorithms.If(
        isHighScore,
        'High',
        ee.Algorithms.If(
          isMedScore,
          'Medium',
          'Low'
        )
      ));

      // Resource figures with the TIER plantable fraction (High 20%, Medium
      // 25%, Low 30% of the missing-canopy area), mirroring
      // calculateTreeResources so the ward table and CSV export reconcile
      // with the panel for every tier instead of only the medium one.
      var treeCfg = RESOURCE_CONFIG.tree;
      var plantable = ee.Number(ee.Algorithms.If(
        ee.Algorithms.IsEqual(level, 'High'), treeCfg.plantableFraction.high,
        ee.Algorithms.If(ee.Algorithms.IsEqual(level, 'Medium'),
          treeCfg.plantableFraction.medium, treeCfg.plantableFraction.low)));
      var deficitHa = getNumber(f, 'canopyDeficit_ha', 0);
      var treesNeeded = deficitHa.multiply(plantable)
        .multiply(treeCfg.treesPerPlantableHa).ceil();
      var saplingsToPlant = treesNeeded.multiply(treeCfg.mortalityBuffer).ceil();
      var totalCost_Lakhs = saplingsToPlant.multiply(treeCfg.costPerTree_mid).divide(100000);

      return f.set({
        'priority_level': level,
        'plantableFraction': plantable,
        'treesNeeded': treesNeeded,
        'saplingsToPlant': saplingsToPlant,
        'totalCost_Lakhs': totalCost_Lakhs
      });
    });

    return finalWards;

  } catch (e) {
    return createDefaultWardResults(wards);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 24-HOUR ACTIVITY HEAT ZONES (MODIS + VIIRS + WorldPop)
// ─────────────────────────────────────────────────────────────────────────
// IPCC 3-FACTOR FRAMEWORK: Heat Stress = (H × E × V)^(1/3) × 100
//
// H (HAZARD): NIGHTTIME Temperature ONLY (MODIS LST at 1km resolution)
//   - Nighttime: Average of Terra (10:30 PM) + Aqua (1:30 AM)
//   - Markets/industrial areas stay hot at night due to activity and thermal mass
//   - Residential areas cool down at night regardless of daytime heat
//   - Normalized to P5/P95 of nighttime temperatures
//
// E (EXPOSURE): Population (WorldPop at 100m resolution)
//   - Log-transformed: ln(population + 1)
//   - Normalized to P5/P95 of log values
//   - Balances absolute count vs density
//
// V (VULNERABILITY): Nightlights FILTERED to non-residential areas (VIIRS + GHSL)
//   - GHSL NRES (100m, 2025) filters nightlights to commercial/industrial zones only
//   - REMOVES: Well-lit residential areas (infrastructure quality, not economic activity)
//   - KEEPS: Markets, factories, shops, transport hubs (true economic activity)
//   - Threshold: NRES > 5 m²/pixel = non-residential
//   - Normalized to P5/P95, clamped to [0.01, 1.0]
//
// Geometric mean ensures all factors must be elevated for high scores
function calculateActivityHeatStress_Ward(wards, popWards, modisDay, modisNight, nightlights, ghsl_nres) {
  try {
    // ⚡ LAYER CACHE: finished ward table with scores + priority_level.
    if (cityHasLayerCache(cityName)) {
      return ee.FeatureCollection(cacheAssetId(cityName, 'activity_wards'));
    }
    var MODIS_SCALE = 1000;  // Native 1km resolution

    // popWards is pre-computed and passed as parameter

    // 1) Compute mean daytime and nighttime LST per ward (MODIS)
    // Day LST needed for night-cooling deficit calculation
    // Night LST used for heat stress hazard scoring
    var dayLstByWard = modisDay.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.mean().setOutputs(['dayLST_mean']),
      scale: MODIS_SCALE,
      crs: 'EPSG:4326',
      tileScale: 8,  // Added for faster parallelization
      maxPixelsPerRegion: 1e8
    });

    var nightLstByWard = modisNight.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.mean().setOutputs(['nightLST_mean']),
      scale: MODIS_SCALE,
      crs: 'EPSG:4326',
      tileScale: 8,  // Added for faster parallelization
      maxPixelsPerRegion: 1e8
    });

    // 2) Compute mean nightlights per ward (economic activity proxy)
    var ntlByWard = nightlights.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.mean().setOutputs(['ntl_mean'])
        .combine(ee.Reducer.stdDev(), '', true)
        .combine(ee.Reducer.min(), '', true)
        .combine(ee.Reducer.max(), '', true),
      scale: 500,  // Nightlights at ~463m native resolution
      crs: 'EPSG:4326',
      tileScale: 8,  // Added for faster parallelization
      maxPixelsPerRegion: 1e8
    });

    // 3) Compute mean GHSL Non-Residential per ward (commercial/industrial filter)
    var nresByWard = ghsl_nres.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.mean().setOutputs(['nres_mean']),
      scale: 100,  // NRES available at 100m resolution
      crs: 'EPSG:4326',
      tileScale: 8,
      maxPixelsPerRegion: 1e8
    });

    // 4) Use pre-computed population data (for exposure)
    // popWards already contains totalPop per ward

    // 5) Join all results
    var joined = joinWardResults(popWards, dayLstByWard, 'WARD_NO', 'dayLST');
    joined = joinWardResults(joined, nightLstByWard, 'WARD_NO', 'nightLST');
    joined = joinWardResults(joined, ntlByWard, 'WARD_NO', 'ntl');
    joined = joinWardResults(joined, nresByWard, 'WARD_NO', 'nres');

    // 6) Compute percentiles for nighttime temperature normalization
    var nightTempPct = ee.Dictionary(joined
      .filter(ee.Filter.notNull(['nightLST_mean']))
      .reduceColumns(ee.Reducer.percentile([5, 95]).setOutputs(['p5','p95']), ['nightLST_mean'])
    );

    // CRITICAL: Filter nightlights to non-residential areas BEFORE calculating percentiles
    // Otherwise percentiles are calculated from all wards (including residential)
    // but we zero them out later, causing incorrect normalization
    var joinedWithFiltered = joined.map(function(f) {
      var nightActivity = ee.Number(getNumber(f, 'ntl_mean', 0));
      var nresValue = ee.Number(getNumber(f, 'nres_mean', 0));
      var isNonResidential = nresValue.gt(5);  // NRES > 5 m²/pixel = commercial/industrial
      var commercial_ntl = nightActivity.multiply(
        ee.Number(ee.Algorithms.If(isNonResidential, 1, 0))
      );
      return f.set('commercial_ntl', commercial_ntl);
    });

    // Now calculate percentiles from FILTERED nightlights
    var activityPct = ee.Dictionary(joinedWithFiltered
      .filter(ee.Filter.notNull(['commercial_ntl']))
      .filter(ee.Filter.gt('commercial_ntl', 0))  // Only non-residential wards
      .reduceColumns(ee.Reducer.percentile([5, 95]).setOutputs(['p5','p95']), ['commercial_ntl'])
    );

    // dayTempPct removed: hazard uses nighttime temperature only
    var dayP5  = ee.Number(30);
    var dayP95 = ee.Number(40);

    var nightP5  = safeDictNumberNull(nightTempPct, 'p5', 25);
    var nightP95 = safeDictNumberNull(nightTempPct, 'p95', 33);  // Default: nightP5 + 8

    var actP5  = safeDictNumberNull(activityPct, 'p5', 0);
    var actP95 = safeDictNumberNull(activityPct, 'p95', 1);  // Default: actP5 + 1

    // 7) Compute 24-hour heat stress score per ward using IPCC 3-factor framework
    var scored = joinedWithFiltered.map(function(f) {
      var dayTemp = ee.Number(getNumber(f, 'dayLST_mean', 35));
      var nightTemp = ee.Number(getNumber(f, 'nightLST_mean', 28));
      var nightActivity = ee.Number(getNumber(f, 'ntl_mean', 0));
      var nresValue = ee.Number(getNumber(f, 'nres_mean', 0));
      var commercial_nightlights = ee.Number(getNumber(f, 'commercial_ntl', 0));
      var popCount = ee.Number(getNumber(f, 'totalPop', 0)).max(0);  // Using pre-computed population

      // ──────────────────────────────────────────────────────────────────────
      // IPCC 3-FACTOR FRAMEWORK: Heat Stress = H × E × V
      // ──────────────────────────────────────────────────────────────────────

      // COMPONENT 1: HAZARD (H) = Nighttime temperature ONLY
      // Markets/industrial areas stay hot at night due to activity and thermal mass
      // Residential areas cool down at night regardless of daytime heat
      // Normalized to P5/P95 of nighttime temperatures
      var nightHeatIdx = ee.Number(normalizeByPercentiles(ee.Number(nightTemp), ee.Number(nightP5), ee.Number(nightP95)));
      var H = nightHeatIdx;  // Use night temp only (no averaging with day)

      // COMPONENT 2: EXPOSURE (E) = Population (log-transformed)
      // Use ln(population) directly without percentile normalization
      // Log transformation already balances small and large wards appropriately
      // Removes systematic penalty against small wards with high heat exposure
      var popLog = ee.Number(popCount).add(1).log();
      var E = popLog.max(0.01);  // Simple floor to prevent zero

      // COMPONENT 3: VULNERABILITY (V) = Nightlights FILTERED TO NON-RESIDENTIAL AREAS
      // Uses GHSL NRES classification to remove confounding from well-lit residential areas
      // FILTERS OUT: Well-lit residential neighborhoods (high infrastructure, not economic activity)
      // KEEPS: Markets, factories, shops, transport hubs (commercial/industrial zones)
      // THRESHOLD: NRES > 5 m²/pixel = non-residential area
      // NOTE: Filtering done above, percentiles calculated from filtered values only
      var activityIdx = ee.Number(normalizeByPercentiles(commercial_nightlights, ee.Number(actP5), ee.Number(actP95)));
      var V = ee.Number(activityIdx).clamp(0.01, 1.0);

      // FINAL SCORE: Geometric mean of 3 components
      // Score = (H × E × V)^(1/3) × 100
      // Geometric mean ensures all factors must be elevated for high scores
      var score24h = ee.Number(H).multiply(E).multiply(V)
        .pow(ee.Number(1).divide(3))
        .multiply(100);

      // Also compute temperature averages for reference
      var avgTemp = ee.Number(dayTemp).add(nightTemp).divide(2);

      var wardArea = ee.Number(f.geometry().area(1)).divide(1e6);  // m² to km²

      return f.set({
        'activityHeatScore': score24h,
        'dayLST': dayTemp,
        'nightLST': nightTemp,
        'avgLST_24h': avgTemp,
        'nightActivity': nightActivity,
        'population': popCount,
        'totalPop': popCount,  // Match aggregation field name

        // Component scores (for diagnostics)
        'hazard_H': H,
        'exposure_E': E,
        'vulnerability_V': V,

        'wardArea_km2': wardArea  // Calculate from geometry for resource quantification
      });
    });

    return scored;

  } catch (e) {
    return createDefaultWardResults(wards);
  }
}

// ========================================
// IPCC-ALIGNED HEAT RISK INDEX (AR6 Framework)
// ========================================

/**
 * Calculate IPCC AR6-aligned Heat Risk Index
 * Risk = Hazard × Exposure × Vulnerability (multiplicative interaction)
 *
 * IPCC AR6 Definition:
 * - Hazard (H): Heat intensity in built-up areas (UHI_built_p90)
 * - Exposure (E): Population density exposed to heat (popAtRisk / area)
 * - Vulnerability (V): Sensitivity factors (green access deficit, optional informal housing)
 * - Risk (R): H × E × V (after normalization to 0-1)
 *
 * @param {ee.FeatureCollection} wards - Base ward boundaries with WARD_NO, area_km2
 * @param {ee.FeatureCollection} lstWards - From processUrbanLayers (has UHI_built_p90)
 * @param {ee.FeatureCollection} popHeatWards - From calculatePopulationHeatExposure (has popAtRisk)
 * @param {ee.FeatureCollection} canopyGapWards - From calculateTreePlantingPriority_LowCanopy (has greenAccessScore)
 * @param {ee.FeatureCollection} informalHousingWards - Optional, from calculateInformalHousing (has informalScore)
 * @param {Object} options - {includeInformal: boolean}
 * @returns {ee.FeatureCollection} - Wards with riskIndex, hazardIndex, exposureIndex, vulnerabilityIndex, priority_level
 */
function calculateHeatRiskIndex_IPCC(wards, lstWards, popHeatWards, canopyGapWards, coolRoofWards, informalHousingWards, options) {
  try {
    // ════════════════════════════════════════════════════════════════════════
    // COMPOSITE HEAT RISK INDEX - IPCC AR6 FRAMEWORK (v3.0)
    // ════════════════════════════════════════════════════════════════════════
    //
    // H = H1 + H2                  — Sum within Hazard
    // E = E1                       — Single exposure component
    // V = V1 + V2 + V3             — Sum within Vulnerability
    // Risk = (H × E × V)^(1/3)    — Geometric mean across dimensions
    //
    // Sub-components (H and V terms P5-P95 normalized to 0-1, floored at
    // 0.05; E is deliberately NOT normalized — raw ln(pop) scales all scores
    // by a near-constant and percentile classification ignores scale):
    //   H1: Daytime LST hotspot (ward deviation from city mean)
    //   H2: Nighttime temperature hotspot (MODIS night deviation)
    //   E1: ln(totalPop + 1) — log-transformed population (raw, unnormalized)
    //   V1: Tree canopy deficit (1 - normalized canopy fraction)
    //   V2: Dense/vulnerable housing score (informalHousingScore)
    //   V3: Albedo deficit (1 - normalized albedo, darker = higher vulnerability)
    //
    // No averaging needed — percentile classification at the end
    // makes absolute scale irrelevant, only rank order matters.
    // ════════════════════════════════════════════════════════════════════════

    // 1. JOIN ALL WARD DATA DIRECTLY (removing slim mapping actually improves performance)
    var joined = wards;
    joined = joinWardResults(joined, lstWards, 'WARD_NO', 'lst');
    joined = joinWardResults(joined, popHeatWards, 'WARD_NO', 'popHeat');
    if (canopyGapWards) joined = joinWardResults(joined, canopyGapWards, 'WARD_NO', 'canopyGap');
    if (coolRoofWards) joined = joinWardResults(joined, coolRoofWards, 'WARD_NO', 'coolRoof');
    if (informalHousingWards) joined = joinWardResults(joined, informalHousingWards, 'WARD_NO', 'informal');

    // 2. COMPUTE P5-P95 PERCENTILES FOR NORMALIZATION (BATCHED FOR PERFORMANCE)
    // FIX: Filter out null values before computing percentiles to avoid errors
    var validJoined = joined.filter(ee.Filter.and(
      ee.Filter.notNull(['LST_hotspot', 'nighttemp_hotspot']),
      ee.Filter.notNull(['canopyFrac_mean', 'informalHousingScore'])
    ));

    // Compute percentiles separately for albedo since it might be missing
    var mainPercentiles = validJoined.reduceColumns({
      reducer: ee.Reducer.percentile([5, 95]).setOutputs(['lst_p5', 'lst_p95'])
        .combine(ee.Reducer.percentile([5, 95]).setOutputs(['night_p5', 'night_p95']), '', false)
        .combine(ee.Reducer.percentile([5, 95]).setOutputs(['canopy_p5', 'canopy_p95']), '', false)
        .combine(ee.Reducer.percentile([5, 95]).setOutputs(['dense_p5', 'dense_p95']), '', false),
      selectors: ['LST_hotspot', 'nighttemp_hotspot', 'canopyFrac_mean', 'informalHousingScore']
    });

    // Try to compute albedo percentiles from wards that have the property
    var albedoWards = validJoined.filter(ee.Filter.notNull(['builtAlbedo_mean']));
    var albedoPercentiles = ee.Dictionary(ee.Algorithms.If(
      albedoWards.size().gt(0),
      albedoWards.reduceColumns({
        reducer: ee.Reducer.percentile([5, 50, 95]).setOutputs(['albedo_p5', 'albedo_p50', 'albedo_p95']),
        selectors: ['builtAlbedo_mean']
      }),
      // Default albedo values if no wards have builtAlbedo_mean
      ee.Dictionary({'albedo_p5': 0.10, 'albedo_p50': 0.15, 'albedo_p95': 0.25})
    ));

    // Combine all percentiles
    var allPercentiles = mainPercentiles.combine(albedoPercentiles);

    // Extract values from batched computation
    var lstHotP5 = safeDictNumber(allPercentiles, 'lst_p5', -3);
    var lstHotP95 = safeDictNumber(allPercentiles, 'lst_p95', 5);
    var lstHotRange = lstHotP95.subtract(lstHotP5).max(0.1);

    var nightHotP5 = safeDictNumber(allPercentiles, 'night_p5', -2);
    var nightHotP95 = safeDictNumber(allPercentiles, 'night_p95', 3);
    var nightHotRange = nightHotP95.subtract(nightHotP5).max(0.1);

    // canopyFrac_mean is a 0-1 FRACTION (canopyProb aggregate, clamp(0,1)),
    // so fallbacks must be fractional too - the old 0/40 defaults assumed
    // percent and would have collapsed V1 to a constant on fallback.
    var canopyP5 = safeDictNumber(allPercentiles, 'canopy_p5', 0);
    var canopyP95 = safeDictNumber(allPercentiles, 'canopy_p95', 0.40);
    var canopyRange = canopyP95.subtract(canopyP5).max(0.1);

    var denseP5 = safeDictNumber(allPercentiles, 'dense_p5', 0);
    var denseP95 = safeDictNumber(allPercentiles, 'dense_p95', 80);
    var denseRange = denseP95.subtract(denseP5).max(1);

    var albedoP5 = safeDictNumber(allPercentiles, 'albedo_p5', 0.1);
    var albedoP95 = safeDictNumber(allPercentiles, 'albedo_p95', 0.3);
    var albedoP50 = safeDictNumber(allPercentiles, 'albedo_p50', 0.15);
    var albedoRange = albedoP95.subtract(albedoP5).max(0.01);

    // 3. SCORE EACH WARD
    var FLOOR = 0.05;

    var scoredWards = joined.map(function(ward) {
      // FIX: Ensure all properties have safe defaults even if joins failed
      var totalPop = getNumber(ward, 'totalPop', 1000).max(1);  // Default to 1000 if missing
      var lstHotspot = getNumber(ward, 'LST_hotspot', 0);  // Default to city mean (0 deviation)
      var nightHotspot = getNumber(ward, 'nighttemp_hotspot', 0);  // Default to city mean
      var canopyFrac = getNumber(ward, 'canopyFrac_mean', 0.15);  // 0-1 FRACTION; 0.15 = 15% canopy
      var denseHousing = getNumber(ward, 'informalHousingScore', 30);  // Default to moderate density
      // FIX: Use albedoP50 as default if builtAlbedo_mean is missing
      var builtAlbedo = ee.Number(ee.Algorithms.If(
        ee.Algorithms.IsEqual(ward.get('builtAlbedo_mean'), null),
        albedoP50,  // Use median albedo if property missing
        getNumber(ward, 'builtAlbedo_mean', 0.15)
      ));

      // H1: Daytime heat
      var H1 = lstHotspot.subtract(lstHotP5).divide(lstHotRange)
        .clamp(0, 1).max(FLOOR);

      // H2: Nighttime heat
      var H2 = nightHotspot.subtract(nightHotP5).divide(nightHotRange)
        .clamp(0, 1).max(FLOOR);

      // H = H1 + H2 (range 0-2)
      var H = H1.add(H2);

      // E: Population (Exposure)
      // Use ln(population) directly without percentile normalization
      // Log transformation already balances small and large wards appropriately
      // Removes systematic penalty against small wards with high heat risk
      var popLog = totalPop.add(1).log();
      var E = popLog.max(FLOOR);

      // V1: Canopy deficit (inverted)
      var canopyNorm = canopyFrac.subtract(canopyP5).divide(canopyRange)
        .clamp(0, 1);
      var V1 = ee.Number(1).subtract(canopyNorm).max(FLOOR);

      // V2: Dense/vulnerable housing
      var V2 = denseHousing.subtract(denseP5).divide(denseRange)
        .clamp(0, 1).max(FLOOR);

      // V3: Albedo deficit (inverted - darker surfaces are more vulnerable)
      var albedoNorm = builtAlbedo.subtract(albedoP5).divide(albedoRange)
        .clamp(0, 1);
      var V3 = ee.Number(1).subtract(albedoNorm).max(FLOOR);

      // V = V1 + V2 + V3 (range 0-3)
      var V = V1.add(V2).add(V3);

      // Risk = (H × E × V)^(1/3)
      var riskIndex = H.multiply(E).multiply(V)
        .pow(ee.Number(1).divide(3));

      var areaKm2 = ee.Number(ee.Algorithms.If(
        ee.Algorithms.IsEqual(ward.get('area_km2'), null),
        ee.Number(ward.geometry().area(1)).divide(1e6).max(0.01),
        ward.get('area_km2')
      )).max(0.01);

      return ward.set({
        'riskIndex': riskIndex,
        'riskRaw': riskIndex,
        'hazardIndex': H,
        'exposureIndex': E,
        'vulnerabilityIndex': V,
        'hazard_H1_day': H1,
        'hazard_H2_night': H2,
        'vuln_V1_canopy': V1,
        'vuln_V2_housing': V2,
        'vuln_V3_albedo': V3,
        'priority_score': riskIndex,
        'totalPop': totalPop,
        'areaKm2': areaKm2
      });
    });

    // 4. CLASSIFY
    var classified = addPriorityByPercentilesKeepAll(scoredWards, 'riskIndex', 50, 70);
    return classified;

  } catch (e) {
    return createDefaultWardResults(wards);
  }
}

// ========================================
// INFORMAL HOUSING HELPER FUNCTIONS (v2)
// ========================================

// Sentinel-2 cloud masking using QA60 band


// ════════════════════════════════════════════════════════════════════════════════
// DENSE/VULNERABLE HOUSING - THREE COMPONENT VULNERABILITY ASSESSMENT
// ════════════════════════════════════════════════════════════════════════════════
//
// PURPOSE:
// Identify vulnerable housing areas using three key indicators: building density,
// vegetation deficit, and infrastructure quality (via nightlights). This multi-dimensional
// approach provides a more comprehensive assessment than single-metric density.
//
// METHODOLOGY (THREE-COMPONENT VULNERABILITY):
//
//   Data Source 1: GHSL Built Surface P2023A (2025 epoch) - DENSITY
//     - Asset: JRC/GHSL/P2023A/GHS_BUILT_S/2025
//     - Built surface coverage percentage (0-100%), 100m native
//     - Resampled to 10m for integration
//     - Higher density → more vulnerable
//
//   Data Source 2: ESA WorldCover v200 (2020) - VEGETATION
//     - Asset: ESA/WorldCover/v200
//     - Classes: 10 (tree), 20 (shrub), 30 (grass) for vegetation
//     - 10m native resolution
//     - Less vegetation → more vulnerable (inverse relationship)
//
//   Data Source 3: GHSL Building Height (NEW - High Impact Component)
//     - Asset: JRC/GHSL/P2023A/GHS_BUILT_H/2018
//     - Global building height at 100m resolution
//     - Derived from ALOS DSM, SRTM, and Sentinel-2 (2018)
//     - Metric: Average height in meters, inversed and normalized to 0-100
//     - Research: Building height is #2 discriminative feature (23%+ importance)
//     - Impact: Filters out tall formal high-rises, identifies low-rise slums
//
//   METRICS CALCULATED:
//     1. Building Volume: GHSL volume (m³) normalized to 0-100
//     2. Vegetation Deficit: 100 - (vegetation fraction %), normalized
//     3. Low-Rise Indicator: 100 - (building height), normalized (low = informal)
//
//   COMPOSITE INDEX FORMULA (Simple Average - 3-Component):
//     Score = (Volume_norm + VegDeficit_norm + LowRise_norm) / 3
//
//     Where each component is P5-P95 normalized to 0-100
//
//     Geometric mean rationale:
//       - All three factors must be present for high vulnerability
//       - IPCC AR6 framework: Standard for multi-factor risk assessment
//       - Separates dense slums from dense formal apartments
//       - Accuracy: +10-15% improvement (from ~70% to 80-85%)
//
//   Normalization: P5-P95 percentile-based, city-specific for each component
//     - P5 = 5th percentile (baseline)
//     - P95 = 95th percentile (ceiling)
//     - All components scaled to 0-100
//     - Final composite clamped to [0, 100]
//
//   Built Mask: Multi-source consensus
//     - WorldCover class 50 (built-up)
//     - OR GHSL Surface ≥ 10% coverage
//     - Ensures coverage of all built areas
//
// WARD AGGREGATION (Three-Component Statistics):
//   - 4 metrics aggregated to ward level using mean reducer
//   - Binary threshold: vulnerability ≥ 50 for high-risk pixel counting
//   - Ward properties computed:
//     * informalHousingScore: Mean composite vulnerability (0-100)
//     * buildingVolume: Mean volume component (0-100)
//     * vegetationDeficit: Mean vegetation deficit component (0-100)
//     * lowRiseIndicator: Mean low-rise indicator (0-100, inverse of height)
//
// PRIORITY CLASSIFICATION:
//   - Method: Percentile-based (not fixed thresholds)
//   - Low: 0-P50, Medium: P50-P80, High: P80-P100 (top 20% of wards)
//   - Based on composite vulnerability score (informalHousingScore)
//   - Adapts to city's distribution of vulnerable housing
//
// INPUTS:
//   @param {ee.FeatureCollection} wards - City ward boundaries
//   @param {ee.Image} lulc - WorldCover land use/land cover (10m)
//   @param {ee.Image} nightlights - VIIRS nightlights (not used, legacy parameter)
//   @param {ee.Image} ndvi - Vegetation index (not used, legacy parameter)
//   @param {ee.Geometry} cityBoundary - City administrative boundary
//   @param {Object} cityConfig - {name, areaKm2, ...}
//   @param {Object} urbanData - Additional urban data (not used, legacy parameter)
//
// OUTPUTS:
//   @returns {Object} {
//     image: ee.Image - Pixel-level composite vulnerability (0-100, uint8)
//     wards: ee.FeatureCollection - Ward stats with 4 properties (see above)
//     binaryMask: ee.Image - Binary high-vulnerability mask (≥50)
//     classifiedImage: ee.Image - 3-class categorical (1=low 0-33, 2=med 33-66, 3=high 66-100)
//   }
//
// COMPUTATIONAL NOTES:
//   - Processing time: 2-4 minutes for Varanasi (same as before, GHSL raster-only)
//   - Memory: Moderate (raster-only processing, no vector operations)
//   - Resolution: 10m pixel resolution for all components
//   - Three parallel component calculations then combined
//
// IMPROVEMENT OVER PREVIOUS METHODOLOGY:
//   - Added: Low-rise building indicator (inverse of GHSL height) - NEW
//   - Retained: Building volume (GHSL) and vegetation deficit (WorldCover)
//   - Changed: From 2-component to 3-component geometric mean
//   - Benefit: +10-15% accuracy improvement (from ~70% to 80-85%)
//   - Key: Filters out tall formal high-rises while retaining low-rise slum detection
//   - Research: Building height is #2 discriminative feature (23%+ importance)
//   - Advantage: 100% GHSL suite integration, fast raster operations, no vector processing
//
// ════════════════════════════════════════════════════════════════════════════════

function calculateInformalHousing(wards, lulc, nightlights, ndvi, cityBoundary, cityConfig, urbanData) {
  try {
    // ⚡ LAYER CACHE: load the 10m score raster + ward table; binaryMask and
    // classifiedImage are trivial threshold derivations of the raster, so
    // they are rebuilt here exactly as the compute path builds them.
    if (cityHasLayerCache(cityName)) {
      var cachedImg = ee.Image(cacheAssetId(cityName, 'informal_image'))
        .rename('vulnerable_housing');
      return {
        image: cachedImg,
        wards: ee.FeatureCollection(cacheAssetId(cityName, 'informal_wards')),
        binaryMask: cachedImg.gte(50).selfMask().rename('vulnerable_binary'),
        classifiedImage: ee.Image(1)
          .where(cachedImg.gte(33), 2)
          .where(cachedImg.gte(66), 3)
          .updateMask(cachedImg.mask())
          .rename('vulnerability_class')
      };
    }

    // ══════════════════════════════════════════════════════════════════════════════
    // VULNERABLE HOUSING CALCULATION - THREE COMPONENT APPROACH
    // ══════════════════════════════════════════════════════════════════════════════
    //
    // THREE COMPONENTS (all normalized to 0-100, higher = more vulnerable):
    //   1. VOLUME: Building volume from GHSL Built Volume 2025 (m³ per cell)
    //              Captures both horizontal density (coverage) and vertical density (height)
    //   2. VEGETATION DEFICIT: Inverse of vegetation coverage (less green = more vulnerable)
    //   3. LOW-RISE INDICATOR: Inverse of building height from GHSL Built Height 2018
    //              Low buildings (<10m = 1-3 floors) = informal settlements
    //              Research: Building height is #2 discriminative feature (23%+ importance)
    //              Filters out dense formal high-rises (high volume, high height = low vulnerability)
    //
    // FORMULA: Geometric mean of three components (NOT a simple average)
    //   Score = ((Volume+1) x (VegDeficit+1) x (LowRise+1))^(1/3) - 1
    //   Multiplicative, so a spot must score high on ALL THREE to rank high;
    //   one severe factor alone cannot carry it.
    //
    // Resolution: 10m for detailed urban analysis
    // Normalization: P5-P95 percentiles scaled to 0-100 for each component
    // Accuracy Improvement: +10-15% over 2-component baseline (from ~70% to 80-85%)
    // ══════════════════════════════════════════════════════════════════════════════

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 1: COMPONENT 1 - BUILDING VOLUME (DEVELOPMENT INTENSITY)
    // ──────────────────────────────────────────────────────────────────────────

    // Load GHSL building volume (m³ per 100m grid cell)
    // This combines both coverage and height: Volume = Surface × Height
    var ghslVolume = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_V/2025")
      .select('built_volume_total')
      .clip(cityBoundary)
      .resample('bilinear')  // Use bilinear interpolation for smoother 10m result
      .reproject({crs: 'EPSG:4326', scale: 10});

    // Create built-up mask (still need surface data for mask)
    // NOTE (FIX 5 - edge speckle): GHSL_S is 100m native. Reprojecting it
    // straight to 10m expanded every cell into a hard 10x10 nearest-neighbour
    // block, so OR-ing it against crisp 10m WorldCover produced stair-stepped
    // fringes and isolated pixels along built-up boundaries. Note ghslVolume
    // above already resamples bilinearly; the mask source did not - that
    // asymmetry was the speckle. Resample bilinearly so the coarse band is
    // interpolated rather than blocked before it meets the 10m data.
    var ghslSurface = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_S/2025")
      .select('built_surface')
      .clip(cityBoundary)
      .resample('bilinear')
      .reproject({crs: 'EPSG:4326', scale: 10});

    // Build the union at 10m, then smooth it. focal_mode over a 1.5-pixel
    // radius removes salt-and-pepper pixels without eroding real edges:
    // an isolated pixel is outvoted by its neighbours, while a solid block
    // keeps its boundary. Applied to the 0/1 image BEFORE selfMask(), so the
    // smoothing sees zeros as real values rather than as missing data.
    var builtMask = lulc.eq(50)  // WorldCover built-up class
      .or(ghslSurface.gte(10))   // OR GHSL coverage >= 10%
      .reproject({crs: 'EPSG:4326', scale: 10})
      .focal_mode({radius: 1.5, kernelType: 'square', units: 'pixels'})
      .reproject({crs: 'EPSG:4326', scale: 10})
      .selfMask();

    // Get volume statistics for normalization
    var volumeStats = ghslVolume.updateMask(builtMask).reduceRegion({
      reducer: ee.Reducer.percentile([5, 95]),
      geometry: cityBoundary,
      scale: 100,
      maxPixels: 1e9,
      bestEffort: true
    });

    // Safe extraction with fallback values
    var volumeP5 = safeDictNumber(volumeStats, 'built_volume_total_p5',
      0
    );  // null-safe: contains() was true even when the percentile was null
    var volumeP95 = safeDictNumber(volumeStats, 'built_volume_total_p95',
      50000  // Fallback: assume ~50,000 m³ as P95 if no data
    );  // null-safe: contains() was true even when the percentile was null

    // Normalize volume to 0-100 (higher volume = more densely built)
    var volumeRange = volumeP95.subtract(volumeP5);
    var volumeNorm = ghslVolume.updateMask(builtMask)
      .subtract(volumeP5)
      .divide(volumeRange.max(1))  // Avoid division by zero (m3 scale: 1 is
                                   // already negligible, unlike the 0-100 bands)
      .multiply(100)
      .clamp(0, 100)
      .rename('volume_norm');

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 2: COMPONENT 2 - VEGETATION DEFICIT
    // ──────────────────────────────────────────────────────────────────────────

    // Calculate vegetation fraction from WorldCover at 10m
    var vegMask = lulc.eq(10)  // Tree cover
      .or(lulc.eq(20))          // Shrubland
      .or(lulc.eq(30))          // Grassland
      .reproject({crs: 'EPSG:4326', scale: 10});

    // Aggregate vegetation to 100m for smoother patterns
    var vegFraction = vegMask
      .reduceResolution({
        reducer: ee.Reducer.mean(),
        maxPixels: 256
      })
      .reproject({
        crs: 'EPSG:4326',
        scale: 100
      })
      .multiply(100)  // Convert to percentage
      .rename('veg_fraction');

    // Get vegetation statistics for normalization
    var vegStats = vegFraction.updateMask(builtMask).reduceRegion({
      reducer: ee.Reducer.percentile([5, 95]),
      geometry: cityBoundary,
      scale: 100,
      maxPixels: 1e9,
      bestEffort: true
    });

    // Safe extraction with fallback values
    var vegP5 = safeDictNumber(vegStats, 'veg_fraction_p5',
      0
    );  // null-safe: contains() was true even when the percentile was null
    var vegP95 = safeDictNumber(vegStats, 'veg_fraction_p95',
      100
    );  // null-safe: contains() was true even when the percentile was null

    // Calculate vegetation deficit (inverse - less vegetation = more vulnerable)
    var vegRange = vegP95.subtract(vegP5);
    var vegDeficitNorm = vegFraction.updateMask(builtMask)
      .subtract(vegP5)
      .divide(vegRange.max(0.01))  // Epsilon guard only; .max(1) collapsed this
                                   // 0-100 band to binary in low-vegetation cities
      .multiply(-100)  // Negative to invert
      .add(100)        // Shift to 0-100 where 100 = no vegetation
      .clamp(0, 100)
      .rename('vegdeficit_norm');

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 3: COMPONENT 3 - LOW-RISE BUILDING INDICATOR (NEW)
    // ──────────────────────────────────────────────────────────────────────────

    // Load GHSL building height (average height in meters per 100m cell)
    // Low-rise buildings (<10m = 1-3 floors) are characteristic of informal settlements
    // Research shows building height is #2 discriminative feature (23%+ importance)
    // NOTE (vintage mismatch): BUILT_H is 2018 while BUILT_S/BUILT_V are 2025.
    // Any area built after 2018 has no height value, and because the composite
    // multiplies the three components, a masked height erased the pixel entirely
    // -> visible holes in genuinely built-up areas (mostly newer urban fringe).
    // unmask(0) treats "built but no recorded height" as low-rise, which is what
    // this indicator is measuring; builtMask still confines output to built land.
    var ghslHeight = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_H/2018")
      .select('built_height')
      .unmask(0)
      .clip(cityBoundary)
      .reproject({crs: 'EPSG:4326', scale: 100});

    // Get height statistics for normalization
    var heightStats = ghslHeight.updateMask(builtMask).reduceRegion({
      reducer: ee.Reducer.percentile([5, 95]),
      geometry: cityBoundary,
      scale: 100,
      maxPixels: 1e9,
      bestEffort: true
    });

    // Safe extraction with fallback values
    var heightP5 = safeDictNumber(heightStats, 'built_height_p5',
      3  // Fallback: 3m minimum
    );  // null-safe: contains() was true even when the percentile was null
    var heightP95 = safeDictNumber(heightStats, 'built_height_p95',
      20  // Fallback: 20m maximum (typical 5-6 floor building)
    );  // null-safe: contains() was true even when the percentile was null

    // Calculate low-rise indicator (INVERSE of height - lower height = more vulnerable)
    // Normalize to 0-100 where 100 = very low buildings (informal), 0 = tall buildings (formal)
    var heightRange = heightP95.subtract(heightP5);
    var lowRiseNorm = ghslHeight.updateMask(builtMask)
      .subtract(heightP5)
      .divide(heightRange.max(0.01))  // Epsilon guard only (see vegRange note)
      .multiply(-100)  // Negative to invert (low height = high vulnerability)
      .add(100)        // Shift to 0-100 where 100 = low-rise
      .clamp(0, 100)
      .rename('lowrise_norm');


    // ──────────────────────────────────────────────────────────────────────────
    // STEP 4: COMBINE COMPONENTS USING SIMPLE AVERAGE
    // ──────────────────────────────────────────────────────────────────────────

    // Resample all to common 10m resolution for final composite
    var volumeNorm10m = volumeNorm.reproject({crs: 'EPSG:4326', scale: 10});
    var vegDeficitNorm10m = vegDeficitNorm.resample('bilinear')
      .reproject({crs: 'EPSG:4326', scale: 10});
    var lowRiseNorm10m = lowRiseNorm.resample('bilinear')
      .reproject({crs: 'EPSG:4326', scale: 10});

    // Calculate 3-component vulnerability score using geometric mean:
    // Score = ∛(Volume × VegDeficit × LowRise)
    // Geometric mean ensures all components contribute (multiplicative interaction)
    // Note: Visualization uses dynamic percentile-based legend for variability
    var vulnerableHousingScore = volumeNorm10m.add(1)
      .multiply(vegDeficitNorm10m.add(1))
      .multiply(lowRiseNorm10m.add(1))
      .pow(ee.Number(1).divide(3))  // Cube root for 3 components
      .subtract(1)
      .clamp(0, 100)
      .updateMask(builtMask)
      .reproject({crs: 'EPSG:4326', scale: 10})
      .rename('vulnerable_housing');

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 5: WARD AGGREGATION WITH ALL COMPONENTS
    // ──────────────────────────────────────────────────────────────────────────

    var tileScale = (cityConfig.areaKm2 > 1000) ? 16 : 8;

    // Create multi-band image for efficient ward aggregation
    var componentsImage = vulnerableHousingScore.rename('composite')
      .addBands(volumeNorm10m.rename('volume'))
      .addBands(vegDeficitNorm10m.rename('vegdeficit'))
      .addBands(lowRiseNorm10m.rename('lowrise'));

    // Calculate mean of composite and components per ward
    var wardStats = componentsImage.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.mean(),
      scale: 30,  // 30m for efficient aggregation
      tileScale: tileScale
    }).map(function(ward) {
      var compositeMean = getNumber(ward, 'composite', 0);
      var volumeMean = getNumber(ward, 'volume', 0);
      var vegdeficitMean = getNumber(ward, 'vegdeficit', 0);
      var lowriseMean = getNumber(ward, 'lowrise', 0);

      return ward.set({
        'informalHousingScore': compositeMean,      // 3-component vulnerability score
        'buildingVolume': volumeMean,               // Component 1: Building volume (m³)
        'vegetationDeficit': vegdeficitMean,        // Component 2: Vegetation deficit
        'lowRiseIndicator': lowriseMean             // Component 3: Low-rise building indicator
      });
    });

    // ──────────────────────────────────────────────────────────────────────────
    // STEP 6: PREPARE OUTPUT
    // ──────────────────────────────────────────────────────────────────────────

    // Final image for display (2 or 3-component vulnerability score)
    var displayImage = vulnerableHousingScore
      .toUint8()
      .reproject({crs: 'EPSG:4326', scale: 10});

    // Binary mask for high-vulnerability areas
    var binaryMask = displayImage.gte(50)
      .selfMask()
      .rename('vulnerable_binary');

    // Classified image (Low/Medium/High vulnerability)
    var classified = ee.Image(1)
      .where(displayImage.gte(33), 2)
      .where(displayImage.gte(66), 3)
      .updateMask(builtMask)
      .rename('vulnerability_class');

    return {
      image: displayImage,
      wards: wardStats,
      binaryMask: binaryMask,
      classifiedImage: classified
    };

  } catch (e) {

    // ⚠️ FALLBACK: the computation failed. The uniform score of 50 below is a
    // PLACEHOLDER, not a measurement - and it propagates into Population Heat
    // Risk and the Composite Heat Risk. Previously this happened silently,
    // so a failure was indistinguishable from a valid uniform-vulnerability city.
    print('⚠️ Dense Vulnerable Housing FAILED - showing placeholder score 50 for all wards.');
    print('⚠️ Downstream layers (Population Heat Risk, Composite Heat Risk) are affected.');
    print('⚠️ Error:', e);

    var fallbackImg = ee.Image.constant(50).clip(cityBoundary).rename('informal_risk');
    var defaultWards = wards.map(function (w) {
      return w.set('informalHousingScore', 50)
              .set('informalHousingFallback', 1);  // flag: value is not measured
    });

    return {
      image: fallbackImg,
      wards: defaultWards,
      binaryMask: fallbackImg.gte(50).selfMask(),
      classifiedImage: ee.Image(2)
    };
  }
}


// ───────────────────────────────────────────────────────────────────────────────
// 8. UI COMPONENTS

// Helper to strip emojis from text
function stripEmojis(text) {
  if (!text) return text;
  // Remove emojis using regex pattern (ES5-compatible)
  return text.replace(/[\u2600-\u27BF]|[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '');
}

// Helper to get standard font sizes
function getResponsiveFontSize(type) {
  var sizes = {
    content: '10px',
    sectionTitle: '11px',
    small: '9px',
    tiny: '8px'
  };
  return sizes[type] || '10px';
}

// ───────────────────────────────────────────────────────────────────────────────
// Standardized Panel Section Helpers
// ───────────────────────────────────────────────────────────────────────────────

function addSectionHeader(section, title, color) {
  section.add(ui.Label(stripEmojis(title), {
    fontSize: '11px',
    fontWeight: 'bold',
    color: color,
    margin: '12px 0 4px 0'
  }));
}

function addSectionContent(section, text) {
  if (!text) return;
  section.add(ui.Label(stripEmojis(text), {
    fontSize: '10px',
    color: '#000',
    margin: '0 0 8px 0'
  }));
}

function addBulletList(section, items) {
  if (!items || items.length === 0) return;
  items.forEach(function(item) {
    section.add(ui.Label('• ' + stripEmojis(item), {
      fontSize: '10px',
      color: '#000',
      margin: '0 0 2px 0'
    }));
  });
}

function addSubsectionHeader(section, title) {
  section.add(ui.Label(stripEmojis(title), {
    fontSize: '10px',
    fontWeight: 'bold',
    color: '#000',
    margin: '6px 0 2px 0'
  }));
}

function addAssumptionsText(section, text) {
  section.add(ui.Label('Assumptions: ' + stripEmojis(text), {
    fontSize: '9px',
    color: '#666',
    fontStyle: 'italic',
    margin: '8px 0 0 0'
  }));
}

function createSimpleSection(title, contentWidgets) {
  var titleLabel = ui.Label(title, {
    fontSize: '11px',
    fontWeight: 'bold',
    color: '#000',
    backgroundColor: '#ffffff',
    padding: '6px 10px',
    margin: '0 0 0 0',
    border: '1px solid #e0e0e0'
  });

  var contentPanel = ui.Panel({
    widgets: contentWidgets,
    style: {
      padding: '12px',
      backgroundColor: '#ffffff',
      border: '1px solid #e0e0e0',
      margin: '0 0 12px 0'
    }
  });

  var section = ui.Panel({
    widgets: [titleLabel, contentPanel],
    style: {margin: '0 0 0 0'}
  });

  return {section: section, content: contentPanel, titleLabel: titleLabel};
}

function sanitizeVisParams(vis) {
  vis = vis || {};
  var out = {};
  ['min', 'max', 'palette', 'bands', 'gamma', 'opacity', 'forceRgbOutput'].forEach(function(k) {
    if (vis[k] !== undefined && vis[k] !== null) out[k] = vis[k];
  });
  return out;
}

function addLayerToMap(image, vis, name, shown) {
  try {
    if (DEBUG_MODE) {
    }
    var sanitized = sanitizeVisParams(vis);
    var layer = ui.Map.Layer(image, sanitized, name, shown);
    mapPanel.layers().add(layer);

    if (DEBUG_MODE) {
    }
    return layer;
  } catch (e) {
    throw e;
  }
}

function showLayer(name) {
  // Clear any existing loading timer
  if (globalLoadingTimer) {
    ui.util.clearTimeout(globalLoadingTimer);
    globalLoadingTimer = null;
  }

  // Remove existing loading label if present
  if (globalLoadingLabel) {
    try {
      mapPanel.remove(globalLoadingLabel);
    } catch(e) {
      // Label already removed, ignore error
    }
  }

  // Create/reuse loading indicator
  // Near the map centre (GEE has no 'middle-center'; top-center + margin
  // approximates just-below-centre) and larger, so it is not missed.
  globalLoadingLabel = ui.Label('⏳ Calculating layer...', {
    position: 'top-center',
    margin: '300px 0 0 0',
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    padding: '12px 20px',
    fontSize: '16px',
    color: '#000',
    border: '1px solid #999',
    fontWeight: 'bold'
  });
  mapPanel.add(globalLoadingLabel);

  // Auto-remove after 60 seconds (1 minute)
  globalLoadingTimer = ui.util.setTimeout(function() {
    try {
      if (globalLoadingLabel) {
        mapPanel.remove(globalLoadingLabel);
        globalLoadingLabel = null;
      }
    } catch(e) {
      // Label already removed, ignore error
    }
    globalLoadingTimer = null;
  }, 14000);  // 14s: cached layers load well within this; anything longer lingers

  var found = false;
  mapPanel.layers().forEach(function(layer) {
    var layerName = layer.getName();
    if (layerName === 'City boundary' || layerName === 'Ward Boundaries') {
      layer.setShown(true);
    } else {
      var shouldShow = layerName === name;
      layer.setShown(shouldShow);
      if (shouldShow) {
        found = true;
      }
    }
  });
  if (!found) {
  }
  ensureWardBoundariesOnTop();
}

function ensureWardBoundariesOnTop() {
  var boundaryLayer = null;
  mapPanel.layers().forEach(function(layer) {
    if (layer.getName() === 'Ward Boundaries') {
      boundaryLayer = layer;
    }
  });

  if (boundaryLayer) {
    mapPanel.layers().remove(boundaryLayer);

    // Optimized ward boundaries - outline only (faster rendering)
    var wardsSimplified = wards.map(function(f) {
      return f.simplify(100);  // Simplify geometry to 100m tolerance
    });
    var wardOutlines = ee.Image().byte().paint({
      featureCollection: wardsSimplified,
      color: 1,
      width: 1
    });

    var newBoundaryLayer = ui.Map.Layer(
      wardOutlines,
      {palette: ['000000'], min: 0, max: 1, opacity: 0.6},
      'Ward Boundaries',
      true
    );
    mapPanel.layers().add(newBoundaryLayer);
  }
}

function updateCompactLegend(layerName, legendPanel) {
  legendPanel.clear();

  // Add legend title
  legendPanel.add(ui.Label('LEGEND', {
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#000',
    margin: '0 0 6px 0'
  }));

  var visLookup = {
    'Land Surface Temperature (Daytime, clear-sky)': params.visualization.lst,
    'Surface Temperature Hotspots': params.visualization.uhi,

    'Population Heat Risk': params.visualization.popExposure,

    'Cool Roof Priority': params.visualization.CoolRoof,
    'Tree Planting Priority': params.visualization.greenGaps,
    '24-Hour Heat Zones': params.visualization.economicZones,
    'Dense Vulnerable Housing': params.visualization.informalHousing,
    'Land Use': params.visualization.lulc,
    'Built-Up Probability (Dynamic World)': params.visualization.builtProb,
    'Nighttime Light Intensity': params.visualization.nightlights,
    'Imperviousness': params.visualization.imperv,
    'Surface Albedo': params.visualization.albedo,
    'Population Count': params.visualization.population,
    // 'Settlement Texture (10m)': params.visualization.settlementTexture,  // COMMENTED OUT
    'Composite Heat Risk': params.visualization.vulnerability
  };

  var vis = visLookup[layerName];
  if (!vis) {
    legendPanel.add(ui.Label('No legend available', {fontSize: '12px', color: '#000'}));
    return;
  }

  if (vis.categorical || vis.categories) {
    var categories = vis.categories || ['Low Priority', 'Medium Priority', 'High Priority'];
    var palette = vis.palette || ['#2ca02c', '#ffcc00', '#dc3545'];

    if (layerName === 'Land Use') {
      var lulcValues = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100];
      for (var i = 0; i < categories.length && i < palette.length; i++) {
        legendPanel.add(ui.Panel([
          ui.Label({
            style: {
              backgroundColor: palette[i],
              padding: '6px',
              margin: '0 6px 3px 0',
              width: '16px',
              height: '16px'
            }
          }),
          ui.Label(categories[i] + ' (' + lulcValues[i] + ')', {margin: '0 0 3px 0', fontSize: '12px', color: '#000'})
        ], ui.Panel.Layout.Flow('horizontal')));
      }
    } else {
      for (var i = 0; i < categories.length; i++) {
        legendPanel.add(ui.Panel([
          ui.Label({
            style: {
              backgroundColor: palette[i],
              padding: '6px',
              margin: '0 6px 3px 0',
              width: '16px',
              height: '16px'
            }
          }),
          ui.Label(categories[i], {margin: '0 0 3px 0', fontSize: '12px', color: '#000'})
        ], ui.Panel.Layout.Flow('horizontal')));
      }
    }
  } else {
    // --- Robust numeric handling (prevents blank legend) ---
    var minVal = Number(vis.min);
    var maxVal = Number(vis.max);
    // '41.2°C' and '100%' attach to the number; word units take a space
    var unitLabel = vis.unit
      ? ((vis.unit.charAt(0) === '°' || vis.unit === '%') ? vis.unit : ' ' + vis.unit)
      : '';

    if (!isFinite(minVal) || !isFinite(maxVal)) {
      legendPanel.add(ui.Label('Legend unavailable (missing numeric min/max)', {
        fontSize: '12px', color: '#000'
      }));
      return;
    }

    var colorBar = ui.Thumbnail({
      image: ee.Image.pixelLonLat().select(0),
      params: {
        bbox: [0, 0, 1, 0.1],
        dimensions: '240x16',
        format: 'png',
        min: 0,
        max: 1,
        palette: vis.palette
      },
      style: {stretch: 'horizontal', margin: '4px 0'}
    });

    // Add qualitative labels for 0-100 scaled layers
    // NOTE: Categorical layers (with categories array) are excluded - they render their own labels
    var qualitativeLayers = [
      'Composite Heat Risk',
      'Cool Roof Priority',
      'Tree Planting Priority',
      '24-Hour Heat Zones',
      'Dense Vulnerable Housing'  // Uses dynamic percentile legend with qualitative labels
    ];
    var isQualitative = qualitativeLayers.indexOf(layerName) !== -1;

    // Special labels for Dense Vulnerable Housing (percentile-based)
    var minLabel, maxLabel, midLabel;

    // Check for custom labels (e.g., Population Count layer with log scale)
    if (vis.customLabels) {
      minLabel = vis.customLabels.min;
      midLabel = vis.customLabels.mid || null;
      maxLabel = vis.customLabels.max;
    } else if (layerName === 'Dense Vulnerable Housing') {
      minLabel = 'Very Sparse';
      maxLabel = 'Very Dense';
    } else if (isQualitative) {
      minLabel = 'Low';
      maxLabel = 'High';
    } else {
      minLabel = minVal.toFixed(1) + unitLabel;
      maxLabel = maxVal.toFixed(1) + unitLabel;
    }

    var labelWidgets = [
      ui.Label(minLabel, {margin: '0', fontSize: '11px', color: '#000'})
    ];

    // Add middle label for certain layers. A centred label is only truthful
    // when the value it names sits at the midpoint of min..max, so layers that
    // use it (hotspots, population) must keep their range symmetric / 3-point.
    if (midLabel) {
      labelWidgets.push(ui.Label(midLabel, {margin: '0 auto', fontSize: '11px', color: '#000'}));
    } else if (layerName === 'Surface Temperature Hotspots') {
      labelWidgets.push(ui.Label('0' + unitLabel, {margin: '0 auto', fontSize: '11px', color: '#000'}));
    } else {
      labelWidgets.push(ui.Label('', {margin: '0 auto 0 auto'}));
    }

    labelWidgets.push(ui.Label(maxLabel, {margin: '0', fontSize: '11px', color: '#000'}));

    var labelPanel = ui.Panel({
      widgets: labelWidgets,
      layout: ui.Panel.Layout.Flow('horizontal'),
      style: {stretch: 'horizontal', margin: '0'}
    });

    legendPanel.add(colorBar);
    legendPanel.add(labelPanel);

    // customLabels bypass the per-tick unit suffix, so without this caption
    // the legend read as bare numbers ("1 ... ~30 ... 1,000+") with no unit.
    if (vis.customLabels && vis.unit) {
      legendPanel.add(ui.Label(vis.unit, {
        fontSize: '11px', color: '#555', margin: '2px 0 0 0', fontStyle: 'italic'
      }));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER_METADATA - Concise Descriptions for Policymakers
// ═══════════════════════════════════════════════════════════════════════════════

var LAYER_METADATA = {
  'Land Surface Temperature (Daytime, clear-sky)': {
    description: "WHAT IT IS: Actual surface temperature in degrees Celsius during summer daytime (11 AM satellite overpass).\n\nDATA SOURCE: Landsat 8/9 (2022-2025, 30m, April-July average)\n\nWHAT IT SHOWS:\n• Dark Red-Brown: >50°C - Extremely hot surfaces (dark roofs, asphalt)\n• Deep Orange-Red: 45-50°C - Very hot (concrete, bare ground)\n• Orange: 40-45°C - Hot (typical urban surfaces)\n• Light Yellow: 35-40°C - Warm (mixed urban/vegetation)\n• Pale Cream: <35°C - Cool (parks, water, tree cover)\n\nUSE FOR: Identify extreme heat surfaces for immediate intervention. Target areas >50°C for cool roof programs and shade installation. Compare with air temperature: surface temp is 10-20°C higher (50°C surface ≈ 35-40°C air temp).\n\nNOTE: Surface temperature is 10-20°C higher than air temperature."
  },

  'Surface Temperature Hotspots': {
    description: "WHAT IT IS: Temperature deviation from city average - shows which wards are heat islands vs cool spots.\n\nHOW IT'S CALCULATED:\n• Measures each ward's average surface temperature\n• Subtracts city-wide average temperature\n• Result: Deviation in °C from city mean\n\nWHAT IT SHOWS:\n• Orange: Strongly above average - Severe heat islands\n• Yellow: Moderately above average - Moderate heat islands\n• White: Near city average\n• Light Blue: Moderately below average - Cooler areas\n• Deep Blue: Strongly below average - Cool spots (parks/water)\n\nUSE FOR: Identify physical heat island wards for targeted cooling interventions.\n\nNOTE: The legend range adapts to each city's own P5-P95 spread, so colours are relative to that city - not a fixed °C scale."
  },

  'Built-Up Probability (Dynamic World)': {
    description: "WHAT IT IS: Continuous measure of how built-up each area is (0-100% probability).\n\nDATA SOURCE: Google/WRI Dynamic World (2024, 10m, AI-classified Sentinel-2)\n\nWHAT IT SHOWS:\n• Purple: 90-100% - Densely built areas\n• Near-Black: 70-90% - Heavily built\n• Dark Gray: 50-70% - Moderately built\n• Medium Gray: 25-50% - Mixed built/open\n• Light Gray: 0-25% - Open land/vegetation\n\nUSE FOR: Track gradual settlement expansion and identify growth zones for proactive planning. Target areas transitioning from 40-60% to higher density for early heat mitigation interventions before they become heat islands."
  },

  'Population Heat Risk': {
    description: "WHAT IT IS: Identifies wards where large populations face extreme heat risk. Combines temperature, population size, and housing vulnerability to find priority areas for emergency response.\n\nHOW IT'S CALCULATED: Three factors combined using geometric mean:\n• HAZARD: Daytime surface temperature deviation from city average (Landsat LST hotspot, normalized 0-1)\n• EXPOSURE: Natural log of population (ln(population+1)), normalized to 0-1 using city P5-P95 percentiles to ensure balanced contribution\n• VULNERABILITY: Housing vulnerability score combining density, vegetation deficit, and infrastructure quality (normalized 0-1)\n\nFORMULA: Risk Score = (Hazard × Exposure × Vulnerability)^(1/3) × 100\nAll wards are evaluated equally regardless of built area percentage.\n\nCLASSIFICATION: Based on percentiles across all wards:\n• High Risk (Red): Top 30% of wards (above 70th percentile)\n• Medium Risk (Yellow): Middle 30% (40th-70th percentile)  \n• Low Risk (Green): Bottom 40% (below 40th percentile)\n\nRESOURCE PLANNING: Calculates requirements for high-risk wards: cooling shelters (2 per high-risk ward, 1 per medium, 0.5 per low), ORS packets for vulnerable groups, rehydration stations, and medical preparedness.",
    resourceQuantification: { enabled: true }
  },

  'Cool Roof Priority': {
    description: "WHAT IT IS: Identifies wards where white/reflective roof coatings will provide maximum cooling benefit. Prioritizes areas with hot temperatures, extensive built area, and dark roofs.\n\nHOW IT'S CALCULATED: Three factors combined using geometric mean:\n• TEMPERATURE: Daytime surface temperature (Landsat LST, normalized 0-1 using city percentiles)\n• BUILT FRACTION: Percentage of ward that is built-up (Dynamic World 10m resolution, normalized 0-1)\n• ALBEDO DEFICIT: How dark the roofs are (1 - albedo, where lower albedo = darker = higher priority)\n\nFORMULA: Priority Score = (Temperature × Built Fraction × Albedo Deficit)^(1/3) × 100\nAll wards are evaluated equally regardless of built area percentage.\n\nCLASSIFICATION:\n• High Priority (Dark Brown): Top 30% of wards - hottest areas with most dark roofs\n• Medium Priority (Gray): Middle 30% - moderate heat and roof darkness\n• Low Priority (Light Blue): Bottom 40% - cooler or already has lighter roofs\n\nRESOURCE ESTIMATES: Dark surfaces = built pixels with albedo <0.15 (Sentinel-2 10m); rooftop area estimated as 50% of that dark built surface; coating costs at ₹150-230/m².",
    resourceQuantification: { enabled: true }
  },

  'Tree Planting Priority': {
    description: "WHAT IT IS: Identifies wards needing urgent tree planting based on low existing canopy, high temperatures, and population exposure.\n\nHOW IT'S CALCULATED: Three factors combined using geometric mean:\n• CANOPY DEFICIT: Gap from 20% target coverage (if ward has 5% canopy, deficit = 0.75; normalized 0-1)\n• EXPOSED POPULATION: Natural log of population in low-canopy areas (ln(population+1))\n• HEAT INTENSITY: Surface temperature (Landsat LST, normalized 0-1 using city percentiles)\n\nFORMULA: Priority Score = (Canopy Deficit × Exposed Population × Heat)^(1/3) × 100\nAll wards are evaluated equally regardless of built area percentage.\n\nCLASSIFICATION:\n• High Priority (Brown): Top 30% - Severe canopy deficit (<5%), high heat, large exposed population\n• Medium Priority (Light Green): Middle 30% - Moderate deficit (5-15% canopy)\n• Low Priority (Dark Green): Bottom 40% - Adequate canopy (>15%) or lower urgency\n\nRESOURCE PLANNING: Calculates planting area in hectares, number of saplings (400 trees/hectare mixed urban planting), mortality buffer (35%), and costs (₹750/tree including 3-year maintenance).",
    resourceQuantification: { enabled: true }
  },

  '24-Hour Heat Zones': {
    description: "WHAT IT IS: Identifies commercial and industrial zones where workers face nighttime heat stress - markets, factories, transport hubs.\n\nHOW IT'S CALCULATED: Combines three normalized factors (each 0-1) using geometric mean:\n• NIGHTTIME HEAT: Average temperature at night (MODIS 10:30 PM + 1:30 AM). Commercial areas retain heat from daytime activity.\n• POPULATION EXPOSURE: Natural log of population - ln(population+1) - balances absolute count with density.\n• COMMERCIAL ACTIVITY: Nightlights filtered to non-residential areas using GHSL NRES classification (100m, 2025), focusing on markets, factories, and shops.\n\nFORMULA: Activity Heat Score = (Nighttime Heat × Population × Commercial Activity)^(1/3) × 100\n\nCLASSIFICATION:\n• High Risk (Orange): Top 30% of wards (above 70th percentile) - Persistent nighttime heat in active commercial zones\n• Medium Risk (Gold): Next 30% (40th-70th percentile) - Moderate heat or activity levels\n• Low Risk (Dark Blue): Bottom 40% (below 40th percentile) - Lower heat stress or limited commercial activity\n\nUSE FOR: Target interventions for outdoor workers in markets and industrial areas. Install rehydration stations at busy junctions, provide shade nets for vendors, extend evening clinic hours in high-risk commercial wards.",
    resourceQuantification: { enabled: true }
  },

  'Dense Vulnerable Housing': {
    description: "WHAT IT IS: Identifies vulnerable informal housing with high density, low vegetation, and low-rise buildings - areas combining physical heat vulnerability with informal settlement characteristics.\n\nHOW IT'S CALCULATED: Combines three normalized factors (each 0-100) using geometric mean:\n• BUILDING VOLUME: Built volume from GHSL (2025, 100m). Captures development intensity - both coverage and height (m³ per cell).\n• VEGETATION DEFICIT: Inverse of tree/vegetation cover from WorldCover (2021, 10m). Less green space = higher vulnerability.\n• LOW-RISE INDICATOR: Inverse of building height from GHSL (2018, 100m). Low buildings (<10m = 1-3 floors) typical of informal settlements.\n\nFORMULA: Vulnerability Score = (Volume × VegDeficit × LowRise)^(1/3) - geometric mean ensures all factors contribute.\n\nLEGEND (DYNAMIC - adapts to each city's distribution):\n• VERY DENSE (Top 10%): Extreme vulnerability - dense, low-rise, no vegetation\n• DENSE (75th-90th percentile): High vulnerability - multiple risk factors\n• MODERATE (50th-75th percentile): Medium vulnerability - some risk factors\n• SPARSE (25th-50th percentile): Lower vulnerability - fewer risk factors\n• VERY SPARSE (Bottom 10%): Minimal vulnerability - planned areas with vegetation or tall formal buildings\n\nNote: Legend breaks are city-specific percentiles (P10-P90), NOT fixed 0-100 scale. This ensures good visual contrast for every city regardless of absolute scores.\n\nUSE FOR: Prioritize dense informal settlements for cooling interventions. Target high-vulnerability wards for tree planting, cool roof programs, and community cooling shelters where physical infrastructure AND building type create compounded heat risk.",
    resourceQuantification: { enabled: true }
  },

  'Composite Heat Risk': {
    description: "WHAT IT IS: Overall heat risk score combining all major risk factors - the most comprehensive view of heat vulnerability across the city.\n\nHOW IT'S CALCULATED: IPCC AR6 framework with 6 components across 3 dimensions:\n\nHAZARD (H = H1 + H2):\n• H1: Daytime temperature hotspot (deviation from city average, normalized 0-1)\n• H2: Nighttime temperature hotspot (poor cooling at night, normalized 0-1)\n\nEXPOSURE (E):\n• E: Natural log of population - ln(population+1)\n\nVULNERABILITY (V = V1 + V2 + V3):\n• V1: Tree canopy deficit (1 - canopy%, higher = more vulnerable)\n• V2: Dense housing score (building density, normalized 0-1)\n• V3: Albedo deficit (1 - albedo, darker surfaces = more vulnerable)\n\nFINAL FORMULA: Risk Index = (H × E × V)^(1/3)\n• Geometric mean ensures all components must be elevated for high risk\n• Floor value of 0.05 prevents any component from being zero\n\nCLASSIFICATION:\n• High Risk (Red): Top 30% of wards - Multiple severe risk factors\n• Medium Risk (Amber/Orange): Middle 30% - Some elevated factors\n• Low Risk (Pale Yellow): Bottom 40% - Fewer risk factors\n\nUSE FOR: Prioritize wards needing multiple simultaneous interventions (cooling shelters, tree planting, cool roof programs). Use for comprehensive heat action planning where multiple risk factors overlap.",
    resourceQuantification: { enabled: true }
  },

  'Land Use': {
    description: "WHAT IT IS: Land cover classification from satellite imagery.\n\nDATA SOURCE: ESA WorldCover (2021, 10m)\n\nCATEGORIES:\n• Dark Green: Tree cover\n• Olive Green: Shrubland\n• Pale Green: Grassland and parks\n• Yellow: Cropland\n• Gray: Built-up areas (buildings, roads)\n• Light Taupe: Bare/sparse vegetation\n• Blue: Permanent water bodies\n• Light Blue: Herbaceous wetland\n• Teal: Mangroves\n\nUSE FOR: Identify cooling resources (vegetation, water bodies) vs heat sources (built areas). Target wards with <10% vegetation for tree planting programs. Built areas experience highest temperatures."
  },

  'Nighttime Light Intensity': {
    description: "WHAT IT IS: Nighttime illumination intensity showing economic activity patterns.\n\nDATA SOURCE: VIIRS Nighttime Lights (2023, 500m)\n\nWHAT IT SHOWS:\n• Pale Cream: High intensity - Commercial areas, markets, industrial zones\n• Warm Tan/Gold: Medium intensity - Mixed commercial-residential\n• Slate Blue: Low intensity - Residential areas\n• Dark Navy: No lights - Parks, water, undeveloped land\n\nUSE FOR: Identify active commercial zones with outdoor workers at night (vendors, drivers, security, factory workers). Prioritize bright non-residential areas for evening rehydration stations and worker health outreach."
  },

  'Surface Albedo': {
    description: "WHAT IT IS: Reflectivity of surfaces (0=black, 1=white). Lower values absorb more heat.\n\nDATA SOURCE: Sentinel-2 (10m, Apr-Jul composite) using Bonafoni & Sekertekin (2020) narrow-to-broadband conversion; Landsat 8/9 (30m, Liang 2001) fills residual gaps\n\nVALUES:\n• 0.10-0.15 (Black): Very dark (fresh asphalt, dark roofs) - Maximum heat absorption\n• 0.15-0.25 (Dark Brown): Dark (weathered asphalt, dark concrete)\n• 0.25-0.35 (Medium Brown/Tan): Medium (concrete, traditional roofs)\n• 0.35-0.45 (Light Tan/Beige): Light (light concrete, some cool roofs)\n• 0.45-0.60 (Cream to White): Very light (white roofs, light sand)\n\nUSE FOR: Target dark roofs (albedo <0.15) for cool roof coating programs. Prioritize wards with average albedo <0.20 for reflective coating subsidies to reduce heat absorption."
  },

  'Population Count': {
    description: "WHAT IT IS: Estimated residential population per 100m grid cell.\n\nDATA SOURCE: WorldPop (2020, 100m, UN-adjusted)\n\nWHAT IT SHOWS:\n• Deep Blue: ~1,000+ people per 100m cell - Very high density\n• Medium Blue: ~300-1,000 people per cell - High density\n• Light Blue: ~100-300 people per cell - Medium density\n• Very Pale Blue: <100 people per cell - Low density\n\nUSE FOR: Estimate intervention beneficiaries and calculate resource needs. Prioritize high-density areas (>300 people per 100m cell) for community-level interventions like cooling centers.\n\nNOTE: Displayed on a log scale; legend runs 1 to 1,000+ people per 100m grid cell (the bar's midpoint is ~30 because the scale is logarithmic)."
  },

  'Imperviousness': {
    description: "WHAT IT IS: Percentage of ground covered by impervious surfaces that prevent water infiltration.\n\nDATA SOURCE: Global Human Settlement Layer (2018, 30m)\n\nWHAT IT SHOWS:\n• Dark Slate: 80-100% impervious - Fully paved/built\n• Slate Gray: 60-80% - Mostly paved\n• Blue-Gray: 40-60% - Mixed paved/open\n• Medium Green: 20-40% - Some paving\n• Pale Green: 0-20% - Mostly permeable\n\nUSE FOR: Identify wards with >60% imperviousness for green infrastructure investments (rain gardens, permeable pavement, tree pits). Impervious surfaces trap heat and increase flooding risk - prioritize highly paved areas for greening programs."
  }

  // COMMENTED OUT: Settlement Texture (10m)
  /*
  ,'Settlement Texture (10m)': {
    description: "Shows spatial pattern regularity of buildings. Light gray indicates regular planned grid with uniform building sizes and orientations. Dark purple indicates irregular organic layout with mixed building sizes. Informal settlements show high irregularity from unplanned incremental growth. Planned neighborhoods show low irregularity from uniform design. Helps understand settlement development patterns."
  }
  */

};

function updateLayerDescription(layerName) {
  descSection.clear();
  var myDesc = ++descRequestId;
  var meta = LAYER_METADATA[layerName];

  if (!meta) {
    descSection.add(ui.Label('Select a layer to view details', {fontSize: getResponsiveFontSize('content'), color: '#000'}));
    return;
  }

  // Layer title
  descSection.add(ui.Label(layerName, {
    fontSize: '15px', fontWeight: 'bold', color: '#000', margin: '0 0 8px 0'
  }));

  // Simple concise description
  if (meta.description) {
    descSection.add(ui.Label(meta.description, {
      fontSize: '14px',
      color: '#000',
      margin: '0 0 12px 0',
      whiteSpace: 'pre-wrap'
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // RESOURCE REQUIREMENTS (Dynamic - computed from ward data)
  // ═══════════════════════════════════════════════════════════════════════════════

  // Population Heat Risk - Resource Quantification
  if (meta.resourceQuantification && meta.resourceQuantification.enabled && layerName === 'Population Heat Risk' && wardResults) {
    addSectionHeader(descSection, 'RESOURCE REQUIREMENTS', '#b71c1c');

    var cache = layerStatsCache.population;

    if (cache.status === 'success' && cache.data) {
      var stats = cache.data;
      var numHigh = safeGet(stats, 'highWardCount', 0);
      var numMedium = safeGet(stats, 'mediumWardCount', 0);
      var numLow = safeGet(stats, 'lowWardCount', 0);
      var highExposed = safeGet(stats, 'highExposed', 0);
      var mediumExposed = safeGet(stats, 'mediumExposed', 0);
      var lowExposed = safeGet(stats, 'lowExposed', 0);
      var totalExposed = safeGet(stats, 'totalExposed', 0);

      // Use ward-based calculation
      var wardCounts = { high: numHigh, medium: numMedium, low: numLow };

      // Fallback: If population data hasn't loaded yet, estimate based on ward count
      // Average urban ward in India: ~15,000-20,000 people (using 17,500 as midpoint)
      var avgWardPop = 17500;
      var totalWards = numHigh + numMedium + numLow;
      var estimatedTotalPop = totalExposed > 0 ? totalExposed : (totalWards * avgWardPop);

      var populations = {
        high: highExposed > 0 ? highExposed : (numHigh * avgWardPop),
        medium: mediumExposed > 0 ? mediumExposed : (numMedium * avgWardPop),
        low: lowExposed > 0 ? lowExposed : (numLow * avgWardPop),
        total: estimatedTotalPop
      };
      var resources = calculateEmergencyResourcesByWard(wardCounts, populations);

      // 1. TARGET HEADER
      descSection.add(ui.Label('TARGET: All ' + (numHigh + numMedium + numLow) + ' Wards (Ward-Priority-Based Allocation)', {
        fontSize: '15px', fontWeight: 'bold', color: '#b71c1c', margin: '2px 0 4px 0'
      }));
      descSection.add(ui.Label('High: ' + numHigh + ' wards • Medium: ' + numMedium + ' wards • Low: ' + numLow + ' wards', {
        fontSize: '14px', color: '#000', margin: '0 0 6px 0'
      }));

      // 2. COOLING SHELTERS
      descSection.add(ui.Label('COOLING SHELTERS', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + resources.coolingShelters.total + ' cooling shelters total (ward-priority-based allocation)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('  - High wards: ' + resources.coolingShelters.high + ' (' + numHigh + ' wards × 2 shelters/ward)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 8px'
      }));
      descSection.add(ui.Label('  - Medium wards: ' + resources.coolingShelters.medium + ' (' + numMedium + ' wards × 1 shelter/ward)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 8px'
      }));
      descSection.add(ui.Label('  - Low wards: ' + resources.coolingShelters.low + ' (' + numLow + ' wards ÷ 2 = shared shelters)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 8px'
      }));
      descSection.add(ui.Label('• Cost: ' + formatRupees(resources.coolingShelterCostLakhs * 100000) + ' (₹1.5 lakh per shelter)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: Ward-based allocation ensures geographic equity. Per-ward ratios based on Ahmedabad Municipal Corporation HAP 2013-2024 experience. Design standard: NDMA Cooling Centre Guidelines May 2025, Section 2 (4-6 m²/person, within 0.5 km of hotspot)', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // 3. ORS & REHYDRATION / DRINKING WATER STATIONS
      descSection.add(ui.Label('DRINKING WATER STATIONS', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + resources.rehydrationStations.total + ' drinking water stations total', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('  - High wards: ' + resources.rehydrationStations.high + ' (' + numHigh + ' wards × 2)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 8px'
      }));
      descSection.add(ui.Label('  - Medium wards: ' + resources.rehydrationStations.medium + ' (' + numMedium + ' wards × 1)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 8px'
      }));
      descSection.add(ui.Label('  - Low wards: ' + resources.rehydrationStations.low + ' (' + numLow + ' wards ÷ 2)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 8px'
      }));
      descSection.add(ui.Label('• ' + formatIndianCount(resources.orsPackets) + ' ORS packets total (5,000 packets per station)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Cost: ' + formatRupees(resources.orsCostLakhs * 100000) + ' (₹7/packet)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: Ward-based allocation with 5,000 ORS packets stockpiled per station (replenished as needed). ORS cost: ₹7/packet (NHM government procurement rate, mid-range of ₹5-8)', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // 4. FRONTLINE WORKERS (EXISTING CAPACITY)
      descSection.add(ui.Label('FRONTLINE WORKERS (Existing Capacity)', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + formatIndianCount(resources.ashaWorkers) + ' ASHA workers available', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• ' + formatIndianCount(resources.anganwadiWorkers) + ' Anganwadi workers available', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Role: Door-to-door vulnerable population checks (elderly, children, pregnant), heat awareness messaging, identifying high-risk households, reporting cases to UPHCs/CHCs', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: ASHA: 1 per 1,000 urban pop (NUHM Guidelines). Anganwadi: 1 per 1,000 pop (ICDS norms)', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // 5. MEDICAL PREPAREDNESS
      descSection.add(ui.Label('MEDICAL PREPAREDNESS', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• Hospital beds needed: ' + resources.heatIllnessBeds + ' beds (1 per 10,000 exposed residents)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Extra ambulances needed: ' + resources.ambulancesToPrePosition + ' (1 per 4 high-risk wards)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: Hospital beds planning benchmark: 1 bed per 10,000 exposed residents for heat-related illness surge capacity. Ambulances: Ward-based allocation ensures geographic coverage in high-priority areas', {
        fontSize: '13px', color: '#666', margin: '0 0 1px 8px', fontStyle: 'italic'
      }));
      descSection.add(ui.Label('Heat illness beds: In the absence of official population-based norms, a planning benchmark of 1 heat illness bed per 10,000 exposed residents is used. This is a decision-support benchmark, not a clinical guideline.', {
        fontSize: '13px', color: '#666', margin: '0 0 1px 8px', fontStyle: 'italic'
      }));
      descSection.add(ui.Label('Ambulances: In the absence of official planning norms, a decision-support benchmark of 1 ambulance per 3–4 high-risk wards is used. Pre-position request to EMRI 108, not independent procurement.', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

    } else if (cache.status === 'error') {
      descSection.add(ui.Label('Error loading resource data: ' + (cache.error || 'Unknown error'), {
        fontSize: getResponsiveFontSize('small'), color: '#000', margin: '0 0 2px 0'
      }));

    } else if (cache.status === 'error') {
      descSection.add(ui.Label('⚠️ Error loading resources: ' + (cache.error || 'Unknown error'), {
        fontSize: getResponsiveFontSize('small'), color: '#b71c1c', margin: '0 0 2px 0'
      }));
    } else {
      // Status is 'pending' or 'loading'
      descSection.add(ui.Label('Loading resource calculations...', {
        fontSize: getResponsiveFontSize('small'), color: '#666', margin: '0 0 2px 0'
      }));

      if (cache.status === 'pending') {
        // Trigger the load
        loadPopulationStats(function(data, error) {
          if (error) {
          }
          if (data && isLayerShown(layerName)) {
            updateInfo(layerName);
          }
        });
      }
    }
  }

  // Cool Roof - Resource Quantification
  if (meta.resourceQuantification && meta.resourceQuantification.enabled && layerName === 'Cool Roof Priority' && wardResults) {
    addSectionHeader(descSection, 'RESOURCE REQUIREMENTS', '#b71c1c');

    var cache = layerStatsCache.coolRoof;

    if (cache.status === 'success' && cache.data) {
      var stats = cache.data;
      var numHigh = safeGet(stats, 'highWardCount', 0);
      var highBuiltArea = safeGet(stats, 'highBuiltArea', 0);
      var highPopTotal = safeGet(stats, 'highTotalPop', 0);

      var roofResources = calculateCoolRoofResources(
        safeGet(stats, 'highDarkBuiltArea_m2', 0),  // Changed from highDarkRoofArea_m2
        safeGet(stats, 'highBuildingCountMin', 0),
        safeGet(stats, 'highBuildingCountMax', 0),
        safeGet(stats, 'highTotalPop', 0)
      );

      // TARGET HEADER
      descSection.add(ui.Label('TARGET: ' + numHigh + ' High-Priority Wards (Dark Brown)', {
        fontSize: '15px', fontWeight: 'bold', color: '#b71c1c', margin: '2px 0 4px 0'
      }));

      // DARK BUILT SURFACE AREA (Satellite-measured)
      descSection.add(ui.Label('DARK BUILT SURFACE AREA (Satellite-measured)', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + formatHa(roofResources.darkBuiltArea_ha) + ' ha of built surface (albedo <0.15 - genuinely dark) across high-priority wards', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Includes all impervious surfaces (rooftops, roads, courtyards, paved areas), not rooftops alone', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: Sentinel-2 10m broadband albedo (Bonafoni & Sekertekin 2020), April-July 2022-2025', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // ESTIMATED ROOFTOP AREA
      descSection.add(ui.Label('ESTIMATED ROOFTOP AREA', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + formatHa(roofResources.estimatedRoofArea_ha) + ' ha (50% of total dark built surface)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Requires ground survey to verify', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Cost to treat rooftops: ' + formatRupeeRange(roofResources.costMin_Crores * 10000000,
        roofResources.costMax_Crores * 10000000) + ' at ₹150–230/m²', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Note: Satellite cannot distinguish roofs from roads/courtyards. 50% allocation is conservative estimate. Use this rooftop area estimate for cool roof program procurement.', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // ESTIMATED BUILDINGS (indicative only)
      descSection.add(ui.Label('ESTIMATED BUILDINGS (indicative only)', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      // Round an indicative count to 2 significant figures - false precision
      // on a two-assumptions-deep estimate misleads more than it informs.
      var _rndCount = (function(n) {
        if (!n || n <= 0) return 0;
        var mag = Math.pow(10, Math.floor(Math.log(n) / Math.LN10) - 1);
        return Math.round(n / mag) * mag;
      })(roofResources.buildingCountEst);

      descSection.add(ui.Label('• ~' + formatIndianCount(_rndCount) + ' rooftops (indicative)', {
        fontSize: '16px', fontWeight: 'bold', color: '#4E342E', margin: '2px 0 3px 0'
      }));
      descSection.add(ui.Label('HOW WE GOT THIS NUMBER', {
        fontSize: '13px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 8px'
      }));
      descSection.add(ui.Label(
        '1. ' + formatHa(roofResources.darkBuiltArea_ha) + ' ha of genuinely dark built surface measured (albedo <0.15)\n' +
        '2. x 50% assumed rooftop share (satellite cannot separate roofs from roads/paving) = ' +
        formatHa(roofResources.estimatedRoofArea_ha) + ' ha of dark roofs\n' +
        '3. / 70 m² blended median rooftop = ~' + formatIndianCount(_rndCount) + ' buildings',
        {fontSize: '13px', color: '#000', margin: '0 0 3px 12px', whiteSpace: 'pre-wrap'}
      ));
      descSection.add(ui.Label('Range under other rooftop assumptions: ~' +
        formatIndianCount(roofResources.buildingCountMin) + ' (120 m² planned plots, URDPFI 2014) to ~' +
        formatIndianCount(roofResources.buildingCountMax) + ' (30 m² dense/old city, Census 2011).', {
        fontSize: '12px', color: '#666', margin: '0 0 3px 12px', fontStyle: 'italic'
      }));
      descSection.add(ui.Label('• Building count requires ground survey to verify — use area above for procurement', {
        fontSize: '14px', color: '#000', margin: '0 0 6px 0'
      }));

      // PHASE 1 — GOVERNMENT BUILDINGS
      descSection.add(ui.Label('PHASE 1 — GOVERNMENT BUILDINGS (Start here)', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ~' + roofResources.govtCount + ' buildings: ' +
        roofResources.primarySchools + ' schools + ' +
        roofResources.healthCenters + ' clinics + ' +
        roofResources.communityHalls + ' community halls', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Estimated roof area: ' + formatHa(roofResources.govtRoofArea_m2 / 10000) + ' ha', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Cost: ' + formatRupeeRange(roofResources.govtCostMin_Lakhs * 100000,
        roofResources.govtCostMax_Lakhs * 100000), {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Fund via: AMRUT 2.0 (municipal buildings) or Smart City Mission', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: URDPFI 2014 population norms; building sizes from CPWD standard design + IPHS 2022', {
        fontSize: '13px', color: '#666', margin: '0 0 1px 8px', fontStyle: 'italic'
      }));
      descSection.add(ui.Label('NDMA 2025: SRI ≥ 0.70 mandatory for cooling shelter designation — these buildings are compliance targets', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // PHASE 2 — RESIDENTIAL & COMMERCIAL
      descSection.add(ui.Label('PHASE 2 — RESIDENTIAL & COMMERCIAL', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + formatHa(roofResources.residentialArea_m2 / 10000) +
        ' ha of dark rooftop remaining after government buildings', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• ~' + formatIndianCount(roofResources.residentialCountEst) + ' buildings (indicative; ~' +
        formatIndianCount(roofResources.residentialCountMin) + ' to ~' +
        formatIndianCount(roofResources.residentialCountMax) + ' under the 120 / 30 m² rooftop assumptions)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• ' + formatRupeeRange(roofResources.residentialCostMin_Crores * 10000000,
        roofResources.residentialCostMax_Crores * 10000000) + ' at ₹150–230/m² (Phase 1 + Phase 2 = rooftop total above)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      if (roofResources.govtCapped) {
        descSection.add(ui.Label('Note: the population-based government building estimate (' +
          formatHa(roofResources.govtRoofAreaNorm_m2 / 10000) + ' ha of roof) exceeds the dark rooftop area measured in these wards (' +
          formatHa(roofResources.estimatedRoofArea_ha) + ' ha), so Phase 1 is capped at the measured area and Phase 2 is zero. ' +
          'Treat the government building count as an upper bound.', {
          fontSize: '13px', color: '#b71c1c', margin: '0 0 1px 8px', fontStyle: 'italic'
        }));
      }
      descSection.add(ui.Label('• Requires owner outreach + SDMF subsidy mechanism', {
        fontSize: '14px', color: '#000', margin: '0 0 6px 0'
      }));

      // WHAT THIS TOOL CANNOT TELL YOU
      descSection.add(ui.Label('WHAT THIS TOOL CANNOT TELL YOU', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• Structural suitability of roofs for coating weight', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Ownership status (public vs private)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Existing roof condition', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Ground survey required before any procurement action', {
        fontSize: '14px', color: '#000', margin: '0 0 6px 0'
      }));

    } else if (cache.status === 'error') {
      descSection.add(ui.Label('Error loading resource data: ' + (cache.error || 'Unknown error'), {
        fontSize: getResponsiveFontSize('small'), color: '#000', margin: '0 0 2px 0'
      }));

    } else {
      descSection.add(ui.Label('Loading cool roof calculations...', {
        fontSize: getResponsiveFontSize('small'), color: '#666', margin: '0 0 2px 0'
      }));

      if (cache.status === 'pending') {
        loadCoolRoofStats(function(data, error) {
          if (error) {
          }
          if (data && isLayerShown(layerName)) {
            updateInfo(layerName);
          }
        });
      }
    }
  }

  // Tree Planting - Resource Quantification
  if (meta.resourceQuantification && meta.resourceQuantification.enabled &&
      layerName === 'Tree Planting Priority' &&
      wardResults) {

    addSectionHeader(descSection, 'RESOURCE REQUIREMENTS', '#b71c1c');

    var cache = layerStatsCache.treePlanting;

    if (cache.status === 'success' && cache.data) {
      var stats = cache.data;
      var numHigh = safeGet(stats, 'highWardCount', 0);
      var highDeficitHa = safeGet(stats, 'highDeficitHa', 0);
      var highTotalPop = safeGet(stats, 'highTotalPop', 0);

      var treeResources = calculateTreeResources(highDeficitHa, highTotalPop, 'high', 0, 0, 0);

      // 1. TARGET HEADER
      descSection.add(ui.Label('TARGET: ' + numHigh + ' High-Priority Wards (Brown)', {
        fontSize: '15px', fontWeight: 'bold', color: '#b71c1c', margin: '2px 0 4px 0'
      }));

      // 2. CANOPY DEFICIT
      descSection.add(ui.Label('CANOPY DEFICIT', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + formatHa(highDeficitHa) + ' ha of canopy missing from the built-up area of high-priority wards (built area × shortfall below the 20% target)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: Dynamic World 10m + Sentinel-2 NDVI; target 20% canopy (URDPFI Guidelines 2014: 12-18% minimum green cover for urban areas; MoHUA Urban Greening Guidelines 2014)', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // 3. EXTERNAL SHADE STRUCTURES (if needed - show placeholder)
      if (treeResources.shadeStructures > 0) {
        descSection.add(ui.Label('EXTERNAL SHADE STRUCTURES', {
          fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
        }));
        descSection.add(ui.Label('• ' + treeResources.shadeStructures + ' shade canopies/pergolas needed in wards too dense for tree planting', {
          fontSize: '14px', color: '#000', margin: '0 0 1px 0'
        }));
        descSection.add(ui.Label('Source: UTTIPEC Street Design Guidelines (shade mandatory for pedestrian zones); NDMA Cooling Centre Guidelines May 2025 (shade as heat mitigation)', {
          fontSize: '13px', color: '#666', margin: '0 0 2px 8px', fontStyle: 'italic'
        }));
        descSection.add(ui.Label('Note: For wards with canopy <10% and built fraction >50% where tree planting space is severely limited', {
          fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
        }));
      }

      // 4. PLANTING PLAN
      descSection.add(ui.Label('PLANTING PLAN', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      // ONE headline number: what the city actually has to procure and plant.
      // Previously this line showed trees-needed -> saplings -> survivors, which
      // was a round trip: the buffer multiplied up and the survival rate divided
      // straight back down, so the first and last figures were the same quantity
      // and appeared to contradict each other. Only the procurement figure is
      // actionable, so it leads; the derivation that produced it follows.
      descSection.add(ui.Label('• ' + formatIndianCount(treeResources.saplingsToPlant) + ' saplings to plant', {
        fontSize: '16px', fontWeight: 'bold', color: '#2E7D32', margin: '2px 0 3px 0'
      }));

      // Show the arithmetic, each step traceable back to the analysis
      var _plantablePct = treeResources.gapClosedPct;
      var _bufferPct    = Math.round((RESOURCE_CONFIG.tree.mortalityBuffer - 1) * 100);
      var _survivalPct  = Math.round(RESOURCE_CONFIG.tree.survivalRate3Year * 100);

      descSection.add(ui.Label('HOW WE GOT THIS NUMBER', {
        fontSize: '13px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 8px'
      }));
      descSection.add(ui.Label(
        '1. ' + formatHa(highDeficitHa) + ' ha of canopy missing in the built-up area of the ' + numHigh + ' high-priority wards\n' +
        '2. Closing that gap outright at ' + RESOURCE_CONFIG.tree.treesPerPlantableHa + ' trees/ha (25 m² mature crown) would take ' +
        formatIndianCount(treeResources.treesToCloseGap) + ' trees\n' +
        '3. Only ~' + _plantablePct + '% of that area is realistically plantable in dense wards (roads, parks, open ground) = ' +
        formatIndianCount(treeResources.treesNeeded) + ' trees to establish\n' +
        '4. + ' + _bufferPct + '% extra to cover losses (~' + _survivalPct + '% survive to year 3) = ' +
        formatIndianCount(treeResources.saplingsToPlant) + ' saplings',
        {fontSize: '13px', color: '#000', margin: '0 0 3px 12px', whiteSpace: 'pre-wrap'}
      ));
      descSection.add(ui.Label('Planting ' + formatIndianCount(treeResources.saplingsToPlant) + ' saplings should leave about ' +
        formatIndianCount(treeResources.treesNeeded) + ' established trees after 3 years, closing roughly ' + _plantablePct +
        '% of the measured canopy gap. The remainder needs shade structures or greening at redevelopment - trees alone cannot reach 20% in dense wards.', {
        fontSize: '13px', color: '#444', margin: '0 0 3px 12px', fontStyle: 'italic'
      }));
      descSection.add(ui.Label('This is a PROGRAM TOTAL, phased over 3 years: Year 1 ~50%, Year 2 ~30%, Year 3 ~20% (see PHASING below) - not a single-season ask.', {
        fontSize: '13px', color: '#444', margin: '0 0 3px 12px', fontStyle: 'italic'
      }));
      descSection.add(ui.Label('Source: 400 trees/ha mixed urban context (Karnataka state agroforestry norm); ~' + _survivalPct +
        '% 3-year survival with dedicated maintenance (CAG Audit Report No. 21 of 2013 on Compensatory Afforestation records 7-56% survival where maintenance is poor)', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // 5. LOCATION BREAKDOWN
      descSection.add(ui.Label('LOCATION BREAKDOWN', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• Avenue/roads: ' + formatIndianCount(treeResources.avenueTrees) + ' (IRC:SP:21-2009) | Parks: ' +
        formatIndianCount(treeResources.parkTrees) + ' (URDPFI/AMRUT) | Nagar Van: ' +
        formatIndianCount(treeResources.nagarVanTrees) + ' (NVY/CAMPA) | Institutions: ' +
        formatIndianCount(treeResources.institutionalTrees) + ' (URDPFI)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: IRC:SP:21-2009 Guidelines on Landscaping and Tree Plantation along highways and urban roads (avenue); URDPFI 2014 + AMRUT green spaces (parks); Nagar Van Yojana under CAMPA (urban forest); URDPFI 2014 (institutions)', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // 6. PHASING
      descSection.add(ui.Label('PHASING', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• Year 1: ' + formatIndianCount(treeResources.year1Saplings) + ' saplings (50%) | Year 2: ' +
        formatIndianCount(treeResources.year2Saplings) + ' (30%) | Year 3: ' +
        formatIndianCount(treeResources.year3Saplings) + ' (20%)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: 8-month nursery lead time (State Forest Department procurement cycle). Monsoon planting window (Jun-Sep) dictates annual batch sizes', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // 7. COST
      descSection.add(ui.Label('COST', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + formatRupees(treeResources.costMidLakhs * 100000) +
        ' at ₹' + treeResources.costPerTree +
        '/tree (sapling ₹150–300 + MNREGA labour ₹230 + 3-year maintenance ₹300)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: State Forest Department nursery rates; UP MNREGA wage ₹230/day (2024-25); CAMPA maintenance norms', {
        fontSize: '13px', color: '#666', margin: '0 0 2px 8px', fontStyle: 'italic'
      }));
      descSection.add(ui.Label('Context: CAMPA benchmark ₹5.8–9.2 lakh/ha for block plantation (1000 trees/ha with 5-7 year maintenance)', {
        fontSize: '13px', color: '#666', margin: '0 0 6px 8px', fontStyle: 'italic'
      }));

      // 8. FUNDING
      descSection.add(ui.Label('FUNDING CHANNELS', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('CAMPA/Nagar Van Yojana (saplings + maintenance) | MNREGA (labor: pit digging, planting, watering) | Green India Mission (afforestation) | AMRUT 2.0 (parks development) | Smart City Mission (streetscaping)', {
        fontSize: '14px', color: '#000', margin: '0 0 6px 0'
      }));

    } else if (cache.status === 'error') {
      descSection.add(ui.Label('Error loading resource data: ' + (cache.error || 'Unknown error'), {
        fontSize: getResponsiveFontSize('small'), color: '#000', margin: '0 0 2px 0'
      }));

    } else {
      descSection.add(ui.Label('Loading tree planting calculations...', {
        fontSize: getResponsiveFontSize('small'), color: '#666', margin: '0 0 2px 0'
      }));

      if (cache.status === 'pending') {
        loadTreePlantingStats(function(data, error) {
          if (error) {
          }
          if (data && isLayerShown(layerName)) {
            updateInfo(layerName);
          }
        });
      }
    }
  }

  // 24-Hour Heat Zones Resource Quantification
  if (meta.resourceQuantification && meta.resourceQuantification.enabled &&
      layerName === '24-Hour Heat Zones' &&
      wardResults) {

    addSectionHeader(descSection, 'RESOURCE REQUIREMENTS', '#b71c1c');

    var cache = layerStatsCache.activity;

    if (cache.status === 'success' && cache.data) {
      var stats = cache.data;
      var numHigh = safeGet(stats, 'highWardCount', 0);
      var numMedium = safeGet(stats, 'mediumWardCount', 0);
      var numLow = safeGet(stats, 'lowWardCount', 0);
      var highAreaKm2 = safeGet(stats, 'highAreaKm2', 0);
      var mediumAreaKm2 = safeGet(stats, 'mediumAreaKm2', 0);
      var lowAreaKm2 = safeGet(stats, 'lowAreaKm2', 0);
      var highPop = safeGet(stats, 'highTotalPop', 0);
      var mediumPop = safeGet(stats, 'mediumTotalPop', 0);
      var lowPop = safeGet(stats, 'lowTotalPop', 0);

      // Fallback: If population data unavailable, estimate from ward count
      // Average urban ward in India: ~17,500 people
      var avgWardPop = 17500;
      if (highPop === 0 && numHigh > 0) {
        highPop = numHigh * avgWardPop;
      }
      if (mediumPop === 0 && numMedium > 0) {
        mediumPop = numMedium * avgWardPop;
      }
      if (lowPop === 0 && numLow > 0) {
        lowPop = numLow * avgWardPop;
      }

      // Calculate resources for each tier
      var highResources = calculateActivityResources(highAreaKm2, 10, highPop);
      var mediumResources = calculateActivityResources(mediumAreaKm2, 10, mediumPop);
      var lowResources = calculateActivityResources(lowAreaKm2, 10, lowPop);

      descSection.add(ui.Label(Math.round(numHigh) + ' High-Priority Wards (persistent day-night heat)', {
        fontSize: '15px', fontWeight: 'bold', color: '#b71c1c', margin: '2px 0 4px 0'
      }));

      descSection.add(ui.Label('WATER AND ORAL REHYDRATION SALT STATIONS AT HOTSPOTS', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + highResources.rehydrationStations + ' stations (1 per 10,000 population)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Each station: ~5,000 ORS packets (seasonal stockpile, replenished as needed)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: Decision-support coverage at high-footfall market and transport hubs', {
        fontSize: '13px', color: '#666', margin: '0 0 4px 8px', fontStyle: 'italic'
      }));

      descSection.add(ui.Label('MISTING INSTALLATIONS AT HIGH-FOOTFALL JUNCTIONS', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + numHigh + ' installations (1 per high-activity ward at highest-footfall junction)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: Ahmedabad HAP 2022 market-area interventions. Cooling: 3-5°C local.', {
        fontSize: '13px', color: '#666', margin: '0 0 1px 8px', fontStyle: 'italic'
      }));
      descSection.add(ui.Label('Note: High operational cost (water + electricity) — deploy only at highest-footfall locations during heat alerts', {
        fontSize: '13px', color: '#666', margin: '0 0 4px 8px', fontStyle: 'italic'
      }));

      descSection.add(ui.Label('SHADE STRUCTURES OVER MARKET CORRIDOR SEGMENTS', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• Approximately ' + highResources.shadeNets + ' installations of 100 m² each', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('• Pedestrian shade at highest-footfall segments of active market streets', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: Ahmedabad HAP 2013-2024 operational experience; ₹15,000–25,000 per 100 m² HDPE shade net', {
        fontSize: '13px', color: '#666', margin: '0 0 4px 8px', fontStyle: 'italic'
      }));

      descSection.add(ui.Label('EXTENDED-HOURS UPHCs (High-Priority Wards)', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('• ' + highResources.extendedHoursClinics + ' UPHCs for extended hours (8am-10pm) during heat season', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 0'
      }));
      descSection.add(ui.Label('Source: NUHM: 1 UPHC per 50,000 pop; IPHS 2022. Extended hours ensure access for outdoor workers.', {
        fontSize: '13px', color: '#666', margin: '0 0 1px 8px', fontStyle: 'italic'
      }));
      descSection.add(ui.Label('Note: DC instructs CMO — no new construction needed. Marginal cost: staff overtime + supplies.', {
        fontSize: '13px', color: '#666', margin: '0 0 4px 8px', fontStyle: 'italic'
      }));

      descSection.add(ui.Label('FUNDING CHANNELS', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('Shade nets: Nagar Nigam operational budget | Misting: SDMF | Clinic hours: NHM District Health Action Plan', {
        fontSize: '14px', color: '#666', margin: '0 0 4px 0'
      }));

      descSection.add(ui.Label('', {margin: '2px 0'}));

    } else if (cache.status === 'error') {
      descSection.add(ui.Label('Error loading resource data: ' + (cache.error || 'Unknown error'), {
        fontSize: getResponsiveFontSize('small'), color: '#b71c1c', margin: '0 0 2px 0'
      }));

    } else {
      descSection.add(ui.Label('Loading 24-hour heat zone data...', {
        fontSize: getResponsiveFontSize('small'), color: '#666', margin: '0 0 2px 0'
      }));

      if (cache.status === 'pending') {
        loadActivityStats(function(data, error) {
          if (error) {
          }
          if (data && isLayerShown(layerName)) {
            updateInfo(layerName);
          }
        });
      }
    }
  }

  // Dense Housing Zones - No diagnostic summary or stats needed

  // Composite Heat Risk - Consequence/Urgency Layer
  if (meta.resourceQuantification && meta.resourceQuantification.enabled &&
      layerName === 'Composite Heat Risk' &&
      wardResults) {

    var cache = layerStatsCache.heatRisk;

    if (cache.status === 'success' && cache.data) {
      var stats = cache.data;
      var numHigh = safeGet(stats, 'highWardCount', 0);
      var minRisk = safeGet(stats, 'minRiskIndex', 0);
      var maxRisk = safeGet(stats, 'maxRiskIndex', 2);

      descSection.add(ui.Label('RISK INDEX RANGE', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0'
      }));
      descSection.add(ui.Label('Ward risk index (relative; higher = worse): ' + minRisk.toFixed(2) + ' (lowest) to ' + maxRisk.toFixed(2) + ' (highest)', {
        fontSize: '14px', color: '#000', margin: '0 0 4px 0'
      }));

      descSection.add(ui.Label('Top ' + Math.round(numHigh) + ' Wards by Compound Heat Risk:', {
        fontSize: '15px', fontWeight: 'bold', color: '#b71c1c', margin: '4px 0 2px 0'
      }));

      // Get top wards from wardPriorities
      if (wardPriorities && wardPriorities['Composite Heat Risk']) {
        wardPriorities['Composite Heat Risk'].limit(15).evaluate(function(result) {
          if (myDesc !== descRequestId) return;  // stale: description has moved on
          if (result && result.features) {
            var wardNums = result.features.map(function(f) {
              return f.properties.WARD_NO || f.properties.ward_no || 'N/A';
            });
            descSection.add(ui.Label(wardNums.join(', '), {
              fontSize: '14px', color: '#b71c1c', margin: '0 0 4px 8px'
            }));
          }
        });
      }

      descSection.add(ui.Label('These wards have the worst combination of: extreme daytime heat + poor nighttime cooling + large populations + dense housing + no tree cover + dark roofs', {
        fontSize: '14px', color: '#000', margin: '4px 0 1px 0'
      }));
      descSection.add(ui.Label('  IPCC AR6 Framework: Risk = (Hazard × Exposure × Vulnerability)^(1/3). All six components must be elevated for a ward to rank high.', {
        fontSize: '13px', color: '#666', margin: '0 0 8px 8px', fontStyle: 'italic'
      }));

      descSection.add(ui.Label('Priority actions for these wards:', {
        fontSize: '14px', fontWeight: 'bold', color: '#000', margin: '4px 0 2px 0',
        border: '1px solid #1565C0', backgroundColor: '#E3F2FD', padding: '6px'
      }));
      descSection.add(ui.Label('→ Population Heat Risk: emergency response (cooling shelters, ORS, medical preparedness)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 8px'
      }));
      descSection.add(ui.Label('→ Cool Roof Priority: surface cooling (dark roof coating program)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 8px'
      }));
      descSection.add(ui.Label('→ Tree Planting Priority: shade and greening (canopy deficit)', {
        fontSize: '14px', color: '#000', margin: '0 0 1px 8px'
      }));
      descSection.add(ui.Label('→ 24-Hour Heat Zones: worker protection (rehydration stations, extended clinics)', {
        fontSize: '14px', color: '#000', margin: '0 0 4px 8px'
      }));

      descSection.add(ui.Label('', {margin: '2px 0'}));

    } else if (cache.status === 'error') {
      descSection.add(ui.Label('Error loading risk data: ' + (cache.error || 'Unknown error'), {
        fontSize: getResponsiveFontSize('small'), color: '#b71c1c', margin: '0 0 2px 0'
      }));

    } else {
      descSection.add(ui.Label('Loading compound risk data...', {
        fontSize: getResponsiveFontSize('small'), color: '#666', margin: '0 0 2px 0'
      }));

      if (cache.status === 'pending') {
        loadHeatRiskStats(function(data, error) {
          if (error) {
          }
          if (data && isLayerShown(layerName)) {
            updateInfo(layerName);
          }
        });
      }
    }
  }
}

// FIXED: Updated to show dynamic count and all high-risk wards
// High-priority colour per layer, matching params.visualization palettes.
// Used by the priority panel so its colour words/styling always match the map.
var PRIORITY_HIGH_COLOR = {
  'Population Heat Risk':    {hex: '#E53935', name: 'Red'},
  'Cool Roof Priority':      {hex: '#4E342E', name: 'Dark Brown'},
  'Tree Planting Priority':  {hex: '#A1887F', name: 'Brown'},
  '24-Hour Heat Zones':      {hex: '#FFA726', name: 'Orange'},
  'Dense Vulnerable Housing':{hex: '#441005', name: 'Dark Brown'},
  'Composite Heat Risk':     {hex: '#D32F2F', name: 'Red'}
};

function highColorFor(layerName) {
  return PRIORITY_HIGH_COLOR[layerName] || {hex: '#b71c1c', name: 'Red'};
}

function updatePriorityWardDisplay(layerName) {
  priorityContent.clear();
  var myRequest = ++priorityRequestId;

  if (!wardPriorities) {
    priorityContent.add(ui.Label('Computing priority wards...', {
      fontSize: getResponsiveFontSize('content'),
      color: '#666'
    }));
    return;
  }

  if (!wardPriorities[layerName]) {
    priorityContent.add(ui.Label('No priority ranking for this layer', {
      fontSize: getResponsiveFontSize('content'),
      color: '#666'
    }));
    return;
  }

  var priorityData = wardPriorities[layerName];

  // Default configuration
  var headerText = 'Priority Wards';
  var scoreField = 'priority_score';
  var displayUnit = '';
  var sortDescending = true;
  var isPriorityLayer = false;  // Determines if we show count dynamically

  // Define specific metrics for each layer
  if (layerName === 'Land Surface Temperature (Daytime, clear-sky)') {
    headerText = 'Top 5 Hottest Surface Temp Wards';
    scoreField = 'LST_mean';
    displayUnit = '°C LST';
    isPriorityLayer = false;
  } else if (layerName === 'Surface Temperature Hotspots') {
    headerText = 'Top 5 Surface Temperature Hotspots';
    scoreField = 'LST_hotspot';
    displayUnit = '°C above city average';
    isPriorityLayer = false;
  } else if (layerName === 'Population Heat Risk') {
    headerText = 'Priority Wards: Highest Heat Risk (Hot + Dense + Vulnerable)';
    scoreField = 'riskScore';
    displayUnit = ' risk score';
    isPriorityLayer = true;
  } else if (layerName === 'Cool Roof Priority') {
    headerText = 'High Priority Wards (Dark Brown on Map)';
    scoreField = 'coolRoofPriorityScore';
    displayUnit = ' priority score';
    isPriorityLayer = true;
    // Note: Population is not included as a variable in this layer because cool roof interventions
    // target built surfaces (roofs), not population directly. Priority is based on thermal hazard
    // (heat intensity), exposure (urban density/built fraction), and vulnerability (low albedo).
    // Population benefits are indirect through reduced indoor temperatures.
    // *Built-up area: All areas with any built fraction (ESA WorldCover class 50, aggregated to 100m).
  } else if (layerName === 'Tree Planting Priority') {
    headerText = 'High Priority Wards: Largest Greening Deficit Area';
    scoreField = 'priority_score';  // PRIMARY METRIC: Total area needing greening (m²)
    displayUnit = ' /100 priority score';
    isPriorityLayer = true;
    // Note: This analysis focuses on tree canopy only. External shading devices (pergolas,
    // shade sails, awnings) can also provide cooling through surface and near-surface air
    // temperature reduction but are not considered in this satellite-based assessment.
    //
    // APPLICABILITY: This guidance is designed for typical mid-sized Indian cities and
    // middle-SES neighborhoods in large cities. It may not apply to:
    // - High-rise/high-density areas (Mumbai/Delhi CBDs) where ground-level greening is limited
    // - High-end planned developments with existing adequate infrastructure
    // - Areas with site-specific constraints (shallow soil, underground utilities, etc.)
    //
    // LIMITATIONS: This analysis cannot exclude:
    // - Heavily paved areas (parking lots, industrial zones) unsuitable for trees
    // - Areas with shallow soil depth or underground infrastructure conflicts
    // - Sites requiring specialized design (narrow streets, heritage zones)
    //
    // On-ground calibration and professional judgment are essential for implementation.
  } else if (layerName === '24-Hour Heat Zones') {
    headerText = 'High Risk Wards (Orange on Map)';
    scoreField = 'activityHeatScore';
    displayUnit = ' activity score';
    isPriorityLayer = true;
  } else if (layerName === 'Dense Vulnerable Housing') {
    headerText = 'High Vulnerability Wards (Dense on Map)';
    scoreField = 'informalHousingScore';
    displayUnit = ' vulnerability score';
    isPriorityLayer = true;
  } else if (layerName === 'Composite Heat Risk') {
    headerText = 'High Risk Wards (Red on Map)';
    scoreField = 'riskIndex';
    displayUnit = ' risk score';
    isPriorityLayer = true;
  }

  // Show loading message
  priorityContent.add(ui.Label('Loading priority wards...', {
    fontSize: getResponsiveFontSize('content'),
    color: '#666',
    margin: '4px 0'
  }));


  priorityData.evaluate(function(fc) {
    if (myRequest !== priorityRequestId) return;  // stale: a newer layer/city took over
    priorityContent.clear();

    if (!fc || !fc.features || fc.features.length === 0) {
      priorityContent.add(ui.Label(headerText, {
        fontSize: '11px',
        fontWeight: 'bold',
        color: '#000',
        margin: '0 0 6px 0'
      }));

      var noWardsMsg = 'No high priority wards found';
      if (layerName === 'Tree Planting Priority') {
        noWardsMsg = 'No High Priority wards found.\n\nThis means no wards have canopy coverage ≥20%.\n\nAll wards may already have adequate tree cover.';
      }

      priorityContent.add(ui.Label(noWardsMsg, {
        fontSize: getResponsiveFontSize('content'),
        color: '#666',
        whiteSpace: 'pre-wrap'
      }));
      return;
    }

    // Update header with count for priority layers
    var finalHeaderText = headerText;
    if (isPriorityLayer) {
      var wardCount = fc.features.length;

      // Special case for Tree Planting layer with clearer messaging
      if (layerName === 'Tree Planting Priority') {
        finalHeaderText = wardCount + ' High Priority Wards: Lowest Canopy (<20%), High Built Fraction';
      } else {
        // For other layers, check priority level
        var firstPriorityLevel = fc.features[0].properties ? fc.features[0].properties.priority_level : null;

        if (firstPriorityLevel === 'High') {
          finalHeaderText = wardCount + ' High Priority Wards Found (' +
                            highColorFor(layerName).name + ' on Map)';
        } else {
          finalHeaderText = wardCount + ' Priority Wards';
        }
      }
    }

    priorityContent.add(ui.Label(finalHeaderText, {
      fontSize: '11px',
      fontWeight: 'bold',
      color: highColorFor(layerName).hex,
      margin: '0 0 6px 0'
    }));

    // Add city context for SUHI layers (lazy evaluation for fast loading)
    if ((layerName === 'Surface Temperature Hotspots' || layerName === 'Built Surface Heat (Intervention Zones)') &&
        wardResults && wardResults.uhiStats && wardResults.coolReference) {
      wardResults.coolReference.evaluate(function(refTemp) {
        wardResults.uhiStats.evaluate(function(stats) {
          if (myRequest !== priorityRequestId) return;  // stale response
          if (stats && stats.UHI_mean) {
            var coolBaseline = Number(refTemp).toFixed(1);
            var avgExcess = Number(stats.UHI_mean).toFixed(1);
            var p90Excess = Number(stats.UHI_p90 || 0).toFixed(1);
            var maxExcess = Number(stats.UHI_max || 0).toFixed(1);

            // Add city overview header
            var cityOverviewPanel = ui.Panel({
              widgets: [
                ui.Label('CITY OVERVIEW', {
                  fontSize: getResponsiveFontSize('content'), fontWeight: 'bold', color: '#000', margin: '0 0 2px 0'
                }),
                ui.Label('Cool baseline: ' + coolBaseline + '°C | Avg excess: ' + avgExcess + '°C | Hottest 10%: ≥' + p90Excess + '°C | Max: ' + maxExcess + '°C',
                  {fontSize: getResponsiveFontSize('small'), color: '#000', margin: '0 0 4px 0'}
                ),
                ui.Label('ℹ️ Map shows deviation from city mean (' + avgExcess + '°C). Blue = cooler than average, White = average, Orange/Red = hotter than average',
                  {fontSize: getResponsiveFontSize('small'), color: '#666', fontStyle: 'italic', margin: '0 0 4px 0'}
                )
              ],
              style: {
                padding: '4px 6px',
                margin: '0 0 8px 0',
                border: '1px solid #ffc107'
              }
            });

            priorityContent.insert(1, cityOverviewPanel);
          }
        });
      });

      // Add SUHI exceedance areas using pre-computed lightweight data
      if (wardResults && wardResults.uhiExceedanceAreasData && wardResults.uhiExceedanceAreasData.length > 0) {
        var exceedanceText = [];
        wardResults.uhiExceedanceAreasData.forEach(function(props) {
          var threshold = props.threshold;
          var area = Number(props.area_km2 || 0).toFixed(1);
          var totalArea = Number(props.total_area_km2 || 1);
          var pct = ((props.area_km2 / totalArea) * 100).toFixed(0);

          exceedanceText.push('>' + threshold + '°C: ' + area + ' km² (' + pct + '%)');
        });

        if (exceedanceText.length > 0) {
          var exceedancePanel = ui.Panel({
            widgets: [
              ui.Label('HEAT EXCESS AREAS', {
                fontSize: getResponsiveFontSize('content'), fontWeight: 'bold', color: '#000', margin: '0 0 2px 0'
              }),
              ui.Label(exceedanceText.join(' | '),
                {fontSize: getResponsiveFontSize('small'), color: '#000', margin: '0'}
              )
            ],
            style: {
              padding: '4px 6px',
              margin: '0 0 8px 0',
              border: '1px solid #ef5350'
            }
          });

          priorityContent.insert(2, exceedancePanel);
        }
      }
    }

    // Add city context for LST layer (lazy evaluation for fast loading)
    if (layerName === 'Land Surface Temperature (Daytime, clear-sky)' && wardResults && wardResults.cityHeatStats) {
      wardResults.cityHeatStats.evaluate(function(stats) {
        if (myRequest !== priorityRequestId) return;  // stale response
        if (stats && stats.LST_mean) {
          var cityMean = Number(stats.LST_mean).toFixed(1);
          var cityP90 = Number(stats.LST_p90 || 0).toFixed(1);
          var cityP95 = Number(stats.LST_p95 || 0).toFixed(1);

          // Add city overview header
          var cityOverviewPanel = ui.Panel({
            widgets: [
              ui.Label('CITY OVERVIEW', {
                fontSize: getResponsiveFontSize('content'), fontWeight: 'bold', color: '#000', margin: '0 0 2px 0'
              }),
              ui.Label('Average: ' + cityMean + '°C | Hottest 10%: ≥' + cityP90 + '°C | Top 5%: ≥' + cityP95 + '°C',
                {fontSize: getResponsiveFontSize('small'), color: '#000', margin: '0 0 8px 0'}
              )
            ],
            style: {
              padding: '4px 6px',
              margin: '0 0 8px 0',
              border: '1px solid #ffc107'
            }
          });

          priorityContent.insert(1, cityOverviewPanel);
        }
      });

      // Add threshold exceedance areas using pre-computed lightweight data
      if (wardResults && wardResults.heatExceedanceAreasData && wardResults.heatExceedanceAreasData.length > 0) {
        var exceedanceText = [];
        wardResults.heatExceedanceAreasData.forEach(function(props) {
          var threshold = props.threshold;
          var area = Number(props.area_km2 || 0).toFixed(1);
          var totalArea = Number(props.total_area_km2 || 1);
          var pct = ((props.area_km2 / totalArea) * 100).toFixed(0);

          exceedanceText.push('>' + threshold + '°C: ' + area + ' km² (' + pct + '% of city)');
        });

        if (exceedanceText.length > 0) {
          var exceedancePanel = ui.Panel({
            widgets: [
              ui.Label('AREA ABOVE THRESHOLDS', {
                fontSize: getResponsiveFontSize('content'), fontWeight: 'bold', color: '#000', margin: '0 0 2px 0'
              }),
              ui.Label(exceedanceText.join(' | '),
                {fontSize: getResponsiveFontSize('small'), color: '#000', margin: '0'}
              )
            ],
            style: {
              padding: '4px 6px',
              margin: '0 0 8px 0',
              border: '1px solid #ef5350'
            }
          });

          priorityContent.insert(2, exceedancePanel);
        }
      }
    }

    // Priority layers: sort by ward number for scannability (rank prefix is
    // then dropped). Top-5 layers keep score order - rank is their meaning.
    if (isPriorityLayer) {
      fc.features.sort(function(a, b) {
        var pa = a.properties || {}, pb = b.properties || {};
        var na = Number(pa.WARD_NO || pa.ward_no || pa.wardcode || 0);
        var nb = Number(pb.WARD_NO || pb.ward_no || pb.wardcode || 0);
        return na - nb;
      });
    }

    fc.features.forEach(function(feature, index) {
      var props = feature.properties;

      var wardCode = props.wardcode || props.WARDCODE || props.WARD_NO ||
                     props.ward_no || props.objectid || props.id || (index + 1);

      var wardName = props.ward_name || props.WARD_NAME || props.NAME || props.name ||
                     props.standwardn || props.STANDWARDN || props.sourceward || props.SOURCEWARD ||
                     ('Ward ' + wardCode);

      // ✅ FIX: Normalize Unicode dashes to standard ASCII hyphen (client-side)
      wardName = String(wardName).replace(/[–—−]/g, '-');

      // Get the actual score value
      var scoreValue = props[scoreField];
      var scoreDisplay = 'N/A';
      if (scoreValue !== undefined && scoreValue !== null && !isNaN(Number(scoreValue))) {
        scoreDisplay = Number(scoreValue).toFixed(1) + displayUnit;
      }

      // Get priority level if available
      var priorityLevel = props.priority_level || 'High';

      // Additional context based on layer
      var contextInfo = '';
      if (layerName === 'Surface Temperature Hotspots' || layerName === 'Built Surface Heat (Intervention Zones)') {
        var uhiExcess = props.uhiExcess_C || props.UHI_built_mean || props.UHI_all_mean;
        var coolingPotential = props.coolingPotential_C;
        var targetLST = props.targetLST_C;

        if (uhiExcess !== undefined && coolingPotential !== undefined) {
          contextInfo = 'Excess: ' + Number(uhiExcess).toFixed(1) + '°C, ' +
                        'Cooling potential: ' + Number(coolingPotential).toFixed(1) + '°C';

          // Add intervention guidance based on excess heat
          var excess = Number(uhiExcess);
          var guidance = '';
          if (excess < 3) {
            guidance = ' [Maintain vegetation]';
          } else if (excess < 7) {
            guidance = ' [Add trees & green corridors]';
          } else if (excess < 12) {
            guidance = ' [Cool roofs + canopy expansion]';
          } else {
            guidance = ' [Comprehensive redesign needed]';
          }
          contextInfo += guidance;

          if (targetLST !== undefined) {
            contextInfo += ', Target: ' + Number(targetLST).toFixed(1) + '°C';
          }
        } else if (uhiExcess !== undefined) {
          contextInfo = 'Excess: ' + Number(uhiExcess).toFixed(1) + '°C above cool-vegetation baseline';
        }
      } else if (layerName === 'Land Surface Temperature (Daytime, clear-sky)') {
        var meanTemp = props.LST_mean;
        var maxTemp = props.LST_max;
        var p90Temp = props.LST_p90;

        if (meanTemp !== undefined && maxTemp !== undefined && p90Temp !== undefined) {
          contextInfo = 'Mean: ' + Number(meanTemp).toFixed(1) + '°C, ' +
                        'Max: ' + Number(maxTemp).toFixed(1) + '°C, ' +
                        'P90: ' + Number(p90Temp).toFixed(1) + '°C';
        }
      } else if (layerName === 'Population Heat Risk' || layerName === 'Population Heat Exposure (Emergency Priority)' || layerName === 'High Population Exposure') {
        // Show H-E-V decomposition from IPCC risk framework. Names match what
        // calculatePopulationHeatRisk_v2 actually writes: the components are
        // already scaled 0-100 and the score is 'riskScore'. (The former
        // *Index / popAtRisk names belong to the composite layer and the
        // placeholder table, so this context never rendered.)
        var H = props.hazardComponent;
        var E = props.exposureComponent;
        var V = props.vulnerabilityComponent;
        var riskIndex = props.riskScore;
        var totalPop = props.totalPop;

        // Build context string
        if (H !== undefined && E !== undefined && V !== undefined && riskIndex !== undefined) {
          contextInfo = 'H=' + Number(H).toFixed(0) + ' E=' + Number(E).toFixed(0) + ' V=' + Number(V).toFixed(0) + ' → Risk=' + Number(riskIndex).toFixed(0);
        } else if (riskIndex !== undefined) {
          contextInfo = 'Risk=' + Number(riskIndex).toFixed(0);
        }

        // Ward population (native-grid WorldPop sum)
        if (totalPop !== undefined && totalPop !== null) {
          var popInfo = 'Pop: ' + formatIndianCount(Math.round(Number(totalPop)));
          contextInfo = contextInfo ? contextInfo + ' | ' + popInfo : popInfo;
        }
      } else if (layerName === 'Cool Roof Priority') {
        // Names match what computeCoolRoofPriority actually writes. The former
        // builtLST_p90 / hotBuiltArea_km2 / heatLoad_km2C / lowAlbedoArea_km2 /
        // confidence fields were never produced, so this context never rendered.
        var wardLST = props.LST_mean_ward;
        var albedo = props.builtAlbedo_mean;
        var darkArea_m2 = props.darkBuiltArea_m2;
        var builtFracW = props.builtFrac_ward;
        var cooling = props.potentialCooling_C;

        var parts = [];
        if (wardLST !== undefined && wardLST !== null) {
          parts.push('LST: ' + Number(wardLST).toFixed(1) + '°C');
        }
        if (albedo !== undefined && albedo !== null) {
          parts.push('Albedo: ' + Number(albedo).toFixed(2));
        }
        if (darkArea_m2 !== undefined && darkArea_m2 !== null && darkArea_m2 > 0) {
          parts.push('Dark built: ' + formatHa(Number(darkArea_m2) / 10000) + ' ha');
        }
        if (builtFracW !== undefined && builtFracW !== null) {
          parts.push('Built: ' + (Number(builtFracW) * 100).toFixed(0) + '%');
        }
        if (cooling !== undefined && cooling !== null && cooling > 0) {
          parts.push('Cooling potential: ' + Number(cooling).toFixed(1) + '°C');
        }
        if (parts.length > 0) {
          contextInfo = parts.join(', ');
        }
      } else if (layerName === 'Tree Planting Priority') {
        // For Tree Planting, don't show score or context details - keep it clean
        contextInfo = null;
      } else if (layerName === '24-Hour Heat Zones') {
        contextInfo = 'Priority: ' + priorityLevel;
      }

      // Ward number + name ('Ward 12: Karol Bagh'). Priority layers are in
      // numerical order so the rank prefix is dropped; Top-5 lists keep it.
      var wardText = 'Ward ' + wardCode +
                     (wardName && wardName !== ('Ward ' + wardCode) ? ': ' + wardName : '');
      if (!isPriorityLayer) wardText = (index + 1) + '. ' + wardText;
      var wardPanel = ui.Panel({
        widgets: [
          ui.Label(wardText, {
            fontSize: getResponsiveFontSize('content'),
            color: '#000',
            margin: '2px 0'
          })
        ],
        style: {
          padding: '2px 4px',
          margin: '0'
        }
      });

      priorityContent.add(wardPanel);
    });

    // Add summary note for priority layers
    if (isPriorityLayer && fc.features.length > 5) {
      priorityContent.add(ui.Label('Note: Showing all wards marked as HIGH priority (' +
        highColorFor(layerName).name.toLowerCase() + ' on map)', {
        fontSize: getResponsiveFontSize('small'),
        color: '#666',
        fontStyle: 'italic',
        margin: '8px 0 0 0'
      }));
    }

    // Add policy note for Population Exposure
    if ((layerName === 'Population Heat Risk' || layerName === 'Population Heat Exposure (Emergency Priority)' || layerName === 'High Population Exposure') && fc.features.length > 0) {
      priorityContent.add(ui.Label('IPCC AR6 framework: Score (0–100) = (H × E × V)^(1/3) × 100, where H = ward mean surface temperature, E = ln(ward population), V = dense-housing score, each scaled to the city\'s 5th–95th percentile. Classes: HIGH (red) = top 30% of wards, MEDIUM (yellow) = next 30%, LOW (green) = bottom 40%; the four hottest wards are always HIGH. Cropland-dominated wards are down-weighted. Wards are listed in ward-number order.', {
        fontSize: getResponsiveFontSize('tiny'),
        color: '#000',
        fontStyle: 'italic',
        margin: '8px 0 0 0',
        padding: '4px',
        backgroundColor: '#f0f8ff',
        border: '1px solid #2166ac'
      }));
    }

  }, function(error) {
    priorityContent.clear();
    priorityContent.add(ui.Label(headerText, {
      fontSize: '11px',
      fontWeight: 'bold',
      color: '#000',
      margin: '0 0 6px 0'
    }));
    priorityContent.add(ui.Label('Error loading priority wards: ' + error, {
      fontSize: getResponsiveFontSize('content'),
      color: '#000'
    }));
  });
}

/**
 * Check if a layer is currently shown on the map
 * More robust than checking dropdown value since layers can be toggled via map layer list
 */
function isLayerShown(name) {
  var shown = false;
  mapPanel.layers().forEach(function(layer) {
    if (layer.getName() === name && layer.getShown()) shown = true;
  });
  return shown;
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVE LEGEND SYNC
// The GEE map layer-toggle widget fires no callback, so layers switched there
// (Population Count, Albedo, Imperviousness, Nightlights, Built-Up Probability
// and LST are toggle-only - they are not in the dropdown) left the legend and
// description showing the previously selected layer. This watcher polls the
// visible layer and resyncs the panel whenever it changes, from either route.
// ═══════════════════════════════════════════════════════════════════════════

var lastSyncedLayer = null;
var legendSyncTimer = null;

// Layers that carry no legend/description of their own and must not steal sync
var SYNC_IGNORE = ['Ward Boundaries', 'City boundary'];

function getTopVisibleLayer() {
  var visible = null;
  mapPanel.layers().forEach(function(layer) {
    var n = layer.getName();
    if (layer.getShown() && SYNC_IGNORE.indexOf(n) === -1 && LAYER_METADATA[n]) {
      visible = n;  // last match wins = topmost drawn analytical layer
    }
  });
  return visible;
}

function syncLegendToMap() {
  try {
    var current = getTopVisibleLayer();
    if (current && current !== lastSyncedLayer) {
      lastSyncedLayer = current;
      // Keep the dropdown in step when the layer is one it lists.
      // 'false' suppresses onChange so this does not re-enter updateInfo.
      // items() returns a ui.data.ActiveList; length()/get() are the documented
      // accessors, so read it that way rather than assuming Array methods.
      var inDropdown = false;
      try {
        var items = layerSelect.items();
        for (var i = 0; i < items.length(); i++) {
          if (items.get(i) === current) { inDropdown = true; break; }
        }
      } catch (e) {
        inDropdown = false;  // if the API shape differs, just skip the sync
      }
      if (inDropdown && layerSelect.getValue() !== current) {
        layerSelect.setValue(current, false);
      }
      updateInfo(current);
    }
  } catch (e) {
    // Never let the watcher break the app
  }
  legendSyncTimer = ui.util.setTimeout(syncLegendToMap, 700);
}

function updateInfo(layerName) {
  lastSyncedLayer = layerName;  // keep watcher in step with explicit updates
  try {
    updateCompactLegend(layerName, legendSection);
  } catch (e) {
    legendSection.clear();
    legendSection.add(ui.Label('Legend error: ' + (e.message || e), {color: '#000', fontSize: '11px'}));
  }

  try {
    updateLayerDescription(layerName);
  } catch (e) {
  }

  if (priorityPanel && priorityPanel.style().get('shown')) {
    try {
      updatePriorityWardDisplay(layerName);
    } catch (e) {
    }
  }

  currentLayerLabel.setValue('CURRENT LAYER: ' + layerName);
  currentLayerLabel.style().set('backgroundColor', '#ffffff');
}

// ═══════════════════════════════════════════════════════════════════════════════
// LAYER-SPECIFIC STATS LOADING (Lazy, Independent, Error-Resilient)
// ═══════════════════════════════════════════════════════════════════════════════

// Helper to safely load layer stats with error handling
function loadLayerStats(layerKey, statsDict, callback) {
  var cache = layerStatsCache[layerKey];

  // Already loaded successfully
  if (cache.status === 'success' && cache.data) {
    callback(cache.data, null);
    return;
  }

  // Currently loading - wait for it
  if (cache.status === 'loading') {
    // Check again in 100ms
    ui.util.setTimeout(function() {
      loadLayerStats(layerKey, statsDict, callback);
    }, 100);
    return;
  }

  // Failed before - retry once
  if (cache.status === 'error') {
    callback(null, cache.error);
    return;
  }

  // Start loading
  cache.status = 'loading';

  // evaluate() hands ONE callback (result, error); the old two-callback form
  // never received the server message, so every failure read as the useless
  // 'Evaluation returned null'. Surface the real reason (memory, timeout...).
  statsDict.evaluate(function(result, error) {
    if (result && !error) {
      cache.status = 'success';
      cache.data = result;
      cache.error = null;
      callback(result, null);
    } else {
      cache.status = 'error';
      cache.error = error ? String(error) : 'Evaluation returned null';
      print('⚠️ ' + layerKey + ' stats failed: ' + cache.error);
      callback(null, cache.error);
    }
  });
}

// Load population exposure stats
function loadPopulationStats(callback) {
  if (!wardResults || !wardResults.popHeatWardsPriority) {
    callback(null, 'Ward results not available');
    return;
  }

  var popWards = wardResults.popHeatWardsPriority;
  var highPop = popWards.filter(ee.Filter.eq('priority_level', 'High'));
  var mediumPop = popWards.filter(ee.Filter.eq('priority_level', 'Medium'));
  var lowPop = popWards.filter(ee.Filter.eq('priority_level', 'Low'));

  var stats = ee.Dictionary({
    totalCity: popWards.aggregate_sum('totalPop'),
    totalExposed: popWards.aggregate_sum('totalPop'),
    avgRiskIndex: popWards.aggregate_mean('riskScore'),
    highWardCount: highPop.size(),
    mediumWardCount: mediumPop.size(),
    lowWardCount: lowPop.size(),
    highExposed: highPop.aggregate_sum('totalPop'),
    highTotalPop: highPop.aggregate_sum('totalPop'),
    highAvgRisk: highPop.aggregate_mean('riskScore'),
    highAreaKm2: highPop.aggregate_sum('areaKm2'),
    mediumExposed: mediumPop.aggregate_sum('totalPop'),
    lowExposed: lowPop.aggregate_sum('totalPop')
  });

  loadLayerStats('population', stats, callback);
}

// Load cool roof stats
function loadCoolRoofStats(callback) {
  if (!wardResults || !wardResults.coolRoofWardsPriority) {
    callback(null, 'Ward results not available');
    return;
  }

  var roofWards = wardResults.coolRoofWardsPriority;
  var highRoof = roofWards.filter(ee.Filter.eq('priority_level', 'High'));

  var stats = ee.Dictionary({
    highWardCount: highRoof.size(),
    highBuiltArea: highRoof.aggregate_sum('builtArea_km2'),
    avgAlbedo: roofWards.aggregate_mean('builtAlbedo_mean'),
    highTotalPop: highRoof.aggregate_sum('totalPop'),
    highDarkBuiltArea_m2: highRoof.aggregate_sum('darkBuiltArea_m2'),  // Changed from darkRoofArea_m2
    highBuildingCountMin: highRoof.aggregate_sum('buildingCountMin'),
    highBuildingCountMax: highRoof.aggregate_sum('buildingCountMax')
  });

  loadLayerStats('coolRoof', stats, callback);
}

// Load tree planting stats
function loadTreePlantingStats(callback) {
  if (!wardResults || !wardResults.canopyGapWardsPriority) {
    callback(null, 'Ward results not available');
    return;
  }

  var treeWards = wardResults.canopyGapWardsPriority;
  var highTree = treeWards.filter(ee.Filter.eq('priority_level', 'High'));

  var stats = ee.Dictionary({
    highWardCount: highTree.size(),
    avgCanopy: treeWards.aggregate_mean('treeCanopyPctUrban'),
    totalDeficitHa: treeWards.aggregate_sum('canopyDeficit_ha'),
    highDeficitHa: highTree.aggregate_sum('canopyDeficit_ha'),
    highTotalPop: highTree.aggregate_sum('totalPop'),
    criticalCount: treeWards.filter(ee.Filter.eq('greeningUrgency', 'CRITICAL')).size(),
    severeCount: treeWards.filter(ee.Filter.eq('greeningUrgency', 'SEVERE')).size()
  });

  loadLayerStats('treePlanting', stats, callback);
}

// Load activity heat stats
function loadActivityStats(callback) {
  if (!wardResults || !wardResults.activityHeatWardsPriority) {
    callback(null, 'Ward results not available');
    return;
  }

  var activityWards = wardResults.activityHeatWardsPriority;
  var highWards = activityWards.filter(ee.Filter.eq('priority_level', 'High'));
  var mediumWards = activityWards.filter(ee.Filter.eq('priority_level', 'Medium'));
  var lowWards = activityWards.filter(ee.Filter.eq('priority_level', 'Low'));

  var stats = ee.Dictionary({
    highWardCount: highWards.size(),
    mediumWardCount: mediumWards.size(),
    lowWardCount: lowWards.size(),
    highAreaKm2: highWards.aggregate_sum('wardArea_km2'),
    mediumAreaKm2: mediumWards.aggregate_sum('wardArea_km2'),
    lowAreaKm2: lowWards.aggregate_sum('wardArea_km2'),
    highTotalPop: highWards.aggregate_sum('totalPop'),
    mediumTotalPop: mediumWards.aggregate_sum('totalPop'),
    lowTotalPop: lowWards.aggregate_sum('totalPop'),
    highAvgDayLST: highWards.aggregate_mean('dayLST'),
    highAvgNightLST: highWards.aggregate_mean('nightLST'),
    cityAvgDayLST: activityWards.aggregate_mean('dayLST'),
    cityAvgNightLST: activityWards.aggregate_mean('nightLST')
  });

  loadLayerStats('activity', stats, callback);
}

// Load informal housing stats

// Load heat risk index stats
function loadHeatRiskStats(callback) {
  if (!wardResults || !wardResults.heatRiskWards) {
    callback(null, 'Ward results not available');
    return;
  }

  var riskWards = wardResults.heatRiskWards;
  var highRisk = riskWards.filter(ee.Filter.eq('priority_level', 'High'));
  var mediumRisk = riskWards.filter(ee.Filter.eq('priority_level', 'Medium'));

  var stats = ee.Dictionary({
    highWardCount: highRisk.size(),
    mediumWardCount: mediumRisk.size(),
    avgIndex: riskWards.aggregate_mean('riskIndex'),
    minRiskIndex: riskWards.aggregate_min('riskIndex'),
    maxRiskIndex: riskWards.aggregate_max('riskIndex'),
    highAreaKm2: highRisk.aggregate_sum('areaKm2'),
    highTotalPop: highRisk.aggregate_sum('totalPop')
  });

  loadLayerStats('heatRisk', stats, callback);
}

// ───────────────────────────────────────────────────────────────────────────────
// 9. MAIN ANALYSIS FUNCTION

function runAnalysis() {
  try {
    // ═══════════════════════════════════════════════════════════════════════
    // 🔒 EMAIL ACCESS GATE
    // ═══════════════════════════════════════════════════════════════════════

    var selectedCity = cityName;
    var isPublicCity = PUBLIC_CITIES.indexOf(selectedCity) > -1;

    // PUBLIC CITY (Agra): Hide email panel, log access, and proceed
    if (isPublicCity) {
      // Hide email panel (no add/remove - just toggle visibility)
      emailPanel.style().set('shown', false);
      pendingCity = null;  // any abandoned gate request is void now

      logAccessToSheets('public_user', selectedCity, 'public_access');
    }
    // PROTECTED CITY: Check email verification
    else {
      if (!accessState.emailProvided) {
        // Remove layers but preserve handlers; show the national view
        // behind the verification dialog
        mapPanel.layers().reset();
        mapPanel.setCenter(78.9629, 20.5937, 5);  // India

        // Remove previous denied message if exists
        if (accessDeniedMsg !== null) {
          try {
            mapPanel.remove(accessDeniedMsg);
          } catch (e) {}
          accessDeniedMsg = null;
        }

        // Show the verification dialog (floating panel on the map).
        // The dialog itself is the on-map message; no separate overlay needed.
        emailHeaderLabel.setValue('Unlock ' + selectedCity);
        emailStatusLabel.setValue('Please enter your details to view the selected city. ' +
                                  'You will receive a 4-digit code to access it.');
        showEmailStage('form');
        emailPanel.style().set('shown', true);

        // Debug logging
        print('🔒 ACCESS DENIED: Email required for ' + selectedCity);
        print('🔒 Email panel should be visible in sidebar (orange box)');
        print('🔒 Please enter your email and click "Continue to Analysis"');

        // Log denied access attempt
        logAccessToSheets('anonymous', selectedCity, 'access_denied');

        // wardResults / wards / cityBoundary still belong to the last analysed
        // city, so the global name must keep pointing at it: otherwise the map
        // click handler answers with the old wards under the new name and the
        // cache export would write the old city's tables under the new name.
        pendingCity = selectedCity;
        cityName = computationState.currentCity || 'Agra';

        // STOP EXECUTION - wait for email to be provided
        return;
      }

      // Email already provided - remove denied message and proceed
      if (accessDeniedMsg !== null) {
        try {
          mapPanel.remove(accessDeniedMsg);
        } catch (e) {}
        accessDeniedMsg = null;
      }

      logAccessToSheets(accessState.userEmail, selectedCity, 'analysis_access');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PROCEED WITH ANALYSIS (original code continues below)
    // ═══════════════════════════════════════════════════════════════════════

    if (computationState.isRunning) {
      return;
    }

    computationState.isRunning = true;
    computationState.currentCity = cityName;

    // Only clear cache entries for different city or date range
    // Keep informal housing cache if same city and dates
    if (computationState.lastCity !== cityName ||
        computationState.lastStartDate !== startDate ||
        computationState.lastEndDate !== endDate) {
      computeCache = {};
      computationState.lastCity = cityName;
      computationState.lastStartDate = startDate;
      computationState.lastEndDate = endDate;
    }
    wardResults = null;
    urbanData = null;

    // Composite legend range: back to the layer's default stretch (the same
    // 0-100 the layer is first drawn with) so a previous city's P10/P90 is
    // not shown while this city's range is still resolving.
    params.visualization.vulnerability.min = 0;
    params.visualization.vulnerability.max = 100;
    wardPriorities = {};

    // Reset layer-specific stats cache
    layerStatsCache = {
      population: { status: 'pending', data: null, error: null },
      coolRoof: { status: 'pending', data: null, error: null },
      treePlanting: { status: 'pending', data: null, error: null },
      activity: { status: 'pending', data: null, error: null },
      heatRisk: { status: 'pending', data: null, error: null }
    };

    var progressLabel = ui.Label('Analyzing ' + cityName + '...', {
      position: 'bottom-center',
      backgroundColor: '#ffffff',
      padding: '8px',
      fontSize: '14px',
      color: '#000',
      border: '1px solid #000000'
    });
    mapPanel.add(progressLabel);

    citySelect.setDisabled(true);
    mapPanel.layers().reset();

    var boundaries = loadBoundaries();
    wards = boundaries.wards;
    var cityConfig = boundaries.config;

    // Add area_km2 to wards (needed for Heat Risk Index exposure calculation)
    wards = wards.map(function(f) {
      var a = f.geometry().area(ee.ErrorMargin(1)).divide(1e6); // km²
      return f.set('area_km2', a);
    });

    // Use wards bounds for map centering (fast, simple).
    // The map opens on the India-wide view (setCenter at map creation) and
    // zooms here to the selected city once its analysis runs.
    mapPanel.centerObject(wards, cityConfig.zoomLevel || 11);

    // Set cityBoundary for backward compatibility with existing functions
    cityBoundary = wards.geometry();

    // Set reducerGeom for reduceRegion operations (same as cityBoundary)
    var reducerGeom = cityBoundary;

    // Add city boundary visualization (actual city outline)
    var cityOutline = ee.Image().byte().paint({
      featureCollection: ee.FeatureCollection([ee.Feature(cityBoundary)]),
      color: 1,
      width: 2
    });

    mapPanel.addLayer(
      cityOutline,
      {palette: ['000000'], min: 0, max: 1, opacity: 0.8},
      'City boundary',
      true
    );


    var composite = loadLandsatData(cityBoundary, startDate, endDate, summerFilter);

    var thermalData = calculateAirTempAndNDVI(composite, cityBoundary, cityConfig);
    lst = thermalData.lst;
    ndvi = thermalData.ndvi;
    uhi = thermalData.uhi;

    // City-wide heat statistics for Heat Action Plan context - CLIP FIRST
    var cityHeatStats = lst.clip(cityBoundary).reduceRegion({
      reducer: ee.Reducer.mean()
        .combine(ee.Reducer.percentile([50, 90, 95, 99]), '', true)
        .combine(ee.Reducer.count(), '', true),
      geometry: cityBoundary,
      scale: 30,
      crs: 'EPSG:4326',
      bestEffort: true,
      maxPixels: 1e8,
      tileScale: 8
    });

    // Calculate area above critical thresholds (for Heat Action Plan triggers)
    var HEAT_THRESHOLDS = [40, 45, 50]; // °C
    var totalArea = cityBoundary.area(1).divide(1e6); // km²

    var exceedanceAreas = HEAT_THRESHOLDS.map(function(threshold) {
      var hotArea = lst.gte(threshold).multiply(ee.Image.pixelArea()).divide(1e6); // km²
      var areaSum = hotArea.clip(cityBoundary).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: cityBoundary,
        scale: 30,
        crs: cityConfig.utmZone,
        bestEffort: true,
        maxPixels: 1e8
      });
      return ee.Feature(null, {
        threshold: threshold,
        area_km2: areaSum.get('LST'),
        total_area_km2: totalArea
      });
    });
    var heatExceedanceAreas = ee.FeatureCollection(exceedanceAreas);

    urbanData = processUrbanLayers(cityBoundary, composite, cityConfig);
    lulc = urbanData.lulc;
    nightlights = urbanData.nightlights;

    // ✅ FIX: Remap LULC to discrete indices so colors match legend exactly
    var lulcRemapped = lulc.remap(
      [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100],  // ESA WorldCover class values
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]              // Target indices for palette
    );
    var lulcVizParams = {
      min: 0,
      max: 10,
      palette: params.visualization.lulc.palette
    };
    addLayerToMap(lulcRemapped, lulcVizParams, 'Land Use', true);
    addLayerToMap(lst, params.visualization.lst, 'Land Surface Temperature (Daytime, clear-sky)', false);

    // ════════════════════════════════════════════════════════════════════════
    // URBAN HOTSPOTS - Deviation from City Mean (Standard UHI Method)
    // ════════════════════════════════════════════════════════════════════════
    // Reference: Voogt & Oke (2003), Zhou et al. (2019)
    //
    // Method: Hotspot = LST - City Mean LST
    //
    // Interpretation:
    //   BLUE = Cooler than city average (parks, water, tree cover)
    //   WHITE = City average temperature (0°C deviation)
    //   YELLOW/ORANGE = Hotter than city average (priority intervention zones)
    // ════════════════════════════════════════════════════════════════════════

    var lstClipped = lst.clip(cityBoundary);

    // ✅ DEBUG: Check if LST has valid data
    if (DEBUG_MODE) {
      lstClipped.reduceRegion({
        reducer: ee.Reducer.minMax(),
        geometry: cityBoundary,
        scale: 100,
        bestEffort: true,
        maxPixels: 1e8
      }).evaluate(function(stats) {
        if (stats.LST_min === null || stats.LST_max === null) {
        }
      });
    }

    // Calculate city mean temperature (single number)
    var cityMeanDict = lstClipped.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: cityBoundary,
      scale: 100,  // 100m for mean calculation (faster)
      bestEffort: true,
      maxPixels: 1e9,
      tileScale: 8
    });
    var cityMeanLST = ee.Number(ee.Algorithms.If(
      ee.Algorithms.IsEqual(cityMeanDict.get('LST'), null), 35, cityMeanDict.get('LST')));

    if (DEBUG_MODE) {
      cityMeanLST.evaluate(function(mean) {
      });
    }

    // Create hotspot deviation image (at native 30m resolution)
    var hotspotDeviation = lstClipped.subtract(cityMeanLST).rename('Hotspot');

    // Calculate dynamic range using percentiles (P5 and P95)
    var hotspotStats = hotspotDeviation.reduceRegion({
      reducer: ee.Reducer.percentile([5, 95]),
      geometry: cityBoundary,
      scale: 100,  // Coarse scale for stats calculation
      bestEffort: true,
      maxPixels: 1e9,
      tileScale: 8
    });

    // Extract percentiles with fallback defaults
    var hotspotP5 = ee.Number(ee.Algorithms.If(
      ee.Algorithms.IsEqual(hotspotStats.get('Hotspot_p5'), null),
      -5,  // Fallback if no data
      hotspotStats.get('Hotspot_p5')
    ));
    var hotspotP95 = ee.Number(ee.Algorithms.If(
      ee.Algorithms.IsEqual(hotspotStats.get('Hotspot_p95'), null),
      10,  // Fallback if no data
      hotspotStats.get('Hotspot_p95')
    ));

    // ════════════════════════════════════════════════════════════════════════
    // MODIS NIGHTTIME TEMPERATURE HOTSPOT DEVIATION
    // ════════════════════════════════════════════════════════════════════════
    // Calculate city mean MODIS nighttime temp for comparative H2 component
    //
    // Interpretation:
    //   NEGATIVE = Cooler nights than city average
    //   ZERO = City average nighttime temperature
    //   POSITIVE = Hotter nights than average (poor nocturnal heat relief)
    // ════════════════════════════════════════════════════════════════════════

    var modisNightClipped = urbanData.modisNight.clip(cityBoundary);

    // Calculate city mean nighttime temperature
    var cityMeanNightDict = modisNightClipped.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: cityBoundary,
      scale: 1000,  // MODIS ~1km native resolution
      bestEffort: true,
      maxPixels: 1e9,
      tileScale: 8
    });
    var cityMeanNightTemp = ee.Number(ee.Algorithms.If(
      ee.Algorithms.IsEqual(cityMeanNightDict.get('MODIS_Night_LST'), null), 28, cityMeanNightDict.get('MODIS_Night_LST')));

    // Create nighttime hotspot deviation image
    var nighttempDeviation = modisNightClipped.subtract(cityMeanNightTemp).rename('NighttempHotspot');

    // Diverging palette, SYMMETRIC around white: 7 blues, white, 7 warm colours.
    // Earth Engine spreads palette entries evenly between min and max, so white
    // only lands on 0°C deviation if (a) white is the middle entry and (b) the
    // range is symmetric about zero. Both are enforced below; the previous
    // 5-blue/9-warm palette over an asymmetric P5-P95 range coloured city-average
    // pixels yellow while the legend's centred "0" label claimed they were white.
    var hotspotPalette = [
      // Cooler than city average (blues)
      '#0D47A1',  // Deep blue
      '#1565C0',
      '#1976D2',  // Bright blue
      '#42A5F5',  // Sky blue
      '#90CAF9',  // Light blue
      '#BBDEFB',  // Pale blue
      '#E3F2FD',  // Near-white blue

      // City average (white)
      '#FFFFFF',

      // Hotter than city average (yellow → orange → red-orange)
      '#FFF59D',  // Pale yellow
      '#FFEE58',  // Bright yellow
      '#FFD54F',  // Gold yellow
      '#FFA726',  // Light orange
      '#FF9800',  // Orange
      '#F57C00',  // Dark orange
      '#E65100'   // Red-orange
    ];

    // Legend + layer range are always ±half, so 0°C sits exactly on white and
    // on the centred "0 = city average" label. half is refined from the city's
    // P5/P95 once evaluated (see below); 8°C is only the pre-evaluation default.
    function setHotspotLegend(half) {
      params.visualization.uhi.min = -half;
      params.visualization.uhi.max = half;
      params.visualization.uhi.palette = hotspotPalette;
      params.visualization.uhi.unit = '°C relative to city average';
      params.visualization.uhi.customLabels = {
        min: '−' + half.toFixed(1) + '°C (cooler)',
        mid: '0 = city average',
        max: '+' + half.toFixed(1) + '°C (hotter)'
      };
    }
    setHotspotLegend(8);

    var hotspotVis = {
      min: -8,
      max: 8,
      palette: hotspotPalette
    };


    // Create final hotspot layer at native 30m resolution
    var hotspot = hotspotDeviation.clip(cityBoundary);

    // Evaluate stats for the legend/layer range (async, non-blocking)
    ee.Dictionary({
      mean: cityMeanLST,
      p5: hotspotP5,
      p95: hotspotP95
    }).evaluate(function(stats, error) {
      if (error || !stats || stats.mean === null) {
        print('⚠️ Hotspot range stats failed, keeping ±8°C default: ' + (error || 'null result'));
        return;
      }
      // Symmetric range: the larger of |P5| and |P95|, rounded up to 0.5°C so
      // the legend reads cleanly. Cities with a one-sided spread simply use
      // less of one half of the colour ramp - that is honest, not a defect.
      var half = Math.max(Math.abs(Number(stats.p5) || 0), Math.abs(Number(stats.p95) || 0));
      half = Math.ceil(half * 2) / 2;
      if (!isFinite(half) || half < 1) half = 8;

      setHotspotLegend(half);

      // Update the map layer vis params to match the legend exactly
      mapPanel.layers().forEach(function(layer) {
        if (layer.getName() === 'Surface Temperature Hotspots') {
          layer.setVisParams({
            min: -half,
            max: half,
            palette: hotspotPalette
          });
        }
      });

      // Refresh legend if currently viewing this layer
      if (layerSelect.getValue() === 'Surface Temperature Hotspots') {
        updateCompactLegend('Surface Temperature Hotspots', legendSection);
      }

      if (wardResults) {
        wardResults.cityMeanLST = stats.mean;
      }
    });

    // Surface Temperature Hotspots layer will be added later in correct dropdown order

    // ════════════════════════════════════════════════════════════════════════
    // END OF URBAN HOTSPOTS VISUALIZATION
    // ════════════════════════════════════════════════════════════════════════

    addLayerToMap(nightlights, params.visualization.nightlights, 'Nighttime Light Intensity', false);

    // Extract cool reference temperature from thermal data
    var coolReference = ee.Number(thermalData.lstStats.get('LST_coolRef'));

    // Calculate city-wide SUHI statistics with percentiles for visualization - CLIP FIRST
    var uhiStats = uhi.clip(cityBoundary).reduceRegion({
      reducer: ee.Reducer.percentile([5, 10, 25, 50, 75, 90, 95])
        .combine(ee.Reducer.mean(), '', true)
        .combine(ee.Reducer.minMax(), '', true),
      geometry: reducerGeom,
      scale: 30,
      crs: 'EPSG:4326',
      bestEffort: true,
      maxPixels: 1e8,
      tileScale: 8
    });

    // ❌ REMOVED: Diagnostic .evaluate() call (blocks lazy evaluation)
    // uhiStats.evaluate(function(stats) {
    //   if (stats) {
    //     var dataRange = stats.UHI_max - stats.UHI_min;
    //     var vizRange = 20; // -5 to 15
    //     var coverage = (Math.min(stats.UHI_max, 15) - Math.max(stats.UHI_min, -5)) / vizRange * 100;
    //     // Recommend better range if needed
    //     if (stats.UHI_min > -2 || stats.UHI_max < 10) {
    //     }
    //   }
    // });

    // Calculate area with >10°C SUHI excess (high intervention priority)
    var SUHI_THRESHOLDS = [5, 10, 15]; // °C excess
    var uhiExceedanceAreas = SUHI_THRESHOLDS.map(function(threshold) {
      var hotArea = uhi.gte(threshold).multiply(ee.Image.pixelArea()).divide(1e6); // km²
      var areaSum = hotArea.clip(cityBoundary).reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: cityBoundary,
        scale: 30,
        crs: cityConfig.utmZone,
        bestEffort: true,
        maxPixels: 1e8
      });
      return ee.Feature(null, {
        threshold: threshold,
        area_km2: areaSum.get('UHI'),
        total_area_km2: totalArea
      });
    });
    var uhiExceedanceAreas = ee.FeatureCollection(uhiExceedanceAreas);

    var lstWards = calculateWardHeatIndicators(wards, lst, uhi, lulc, cityConfig, cityMeanLST);

    // ════════════════════════════════════════════════════════════════════════
    // MODIS NIGHTTIME TEMPERATURE AGGREGATION TO WARDS
    // ════════════════════════════════════════════════════════════════════════
    // Aggregate nighttime temperature hotspot to ward level for H2 component
    //
    // nighttemp_hotspot: Ward deviation from city mean (°C)
    //   NEGATIVE = Cooler nights (better nocturnal heat relief)
    //   POSITIVE = Hotter nights (poor nocturnal heat relief)
    // ════════════════════════════════════════════════════════════════════════

    var modisNightByWard = nighttempDeviation.reduceRegions({
      collection: wards,
      reducer: ee.Reducer.mean().setOutputs(['nighttemp_hotspot']),
      scale: 1000,  // MODIS ~1km native resolution
      crs: 'EPSG:4326',
      tileScale: 8
    });

    // Join MODIS nighttime data to lstWards
    lstWards = joinWardResults(lstWards, modisNightByWard, 'WARD_NO', 'modisNight');

    // Add cooling potential to ward results
    lstWards = lstWards.map(function(ward) {
      var uhiBuiltP90 = getNumber(ward, 'UHI_built_p90', 0);
      var uhiBuiltMean = getNumber(ward, 'UHI_built_mean', 0);
      var lstMean = getNumber(ward, 'LST_mean', 35);

      // Realistic intervention targets:
      // Cool roofs: 2-5°C reduction
      // Trees: 1-3°C reduction
      // Cool pavements: 1-2°C reduction
      // Assume 40% reduction achievable through combined interventions
      var maxCoolingPotential = uhiBuiltP90.multiply(0.4);
      var targetLST = lstMean.subtract(maxCoolingPotential);

      return ward.set({
        'coolingPotential_C': maxCoolingPotential,
        'targetLST_C': targetLST,
        'uhiExcess_C': uhiBuiltMean  // Store for reference
      });
    });

    // ✅ SUPPLEMENTAL WARD DATA: Add input variables for Excel export
    // NDVI, MODIS night LST, tree probability, DW built probability,
    // GHSL density, dimness, vegetation deficit
    var supplementalWards = calculateSupplementalWardData(
      wards, ndvi, lulc, nightlights, urbanData, cityBoundary, cityConfig
    );

    // Merge supplemental data into lstWards
    lstWards = joinWardResults(lstWards, supplementalWards, 'WARD_NO', 'supplemental');

    // ✅ PERFORMANCE: Compute shared metrics once (reused by population layer)
    // Eliminates redundant LST P75 computation (saves ~5-10 seconds)
    var sharedMetrics = computeSharedMetrics(lst, cityBoundary);

    // ✅ PERFORMANCE: Compute ward population once (reused by 3 layers)
    // Eliminates redundant worldpop.reduceRegions calls (saves 30-50% time)
    // Also computes cropland % and built % for agricultural ward filtering
    var popWards = computeWardPopulation(wards, urbanData.population, cityConfig,
      urbanData.cropFrac100, urbanData.builtFrac100);

    // ────────────────────────────────────────────────────────────────────────
    // PARALLEL LAYER COMPUTATION START
    // All independent layers can compute simultaneously
    // ────────────────────────────────────────────────────────────────────────

    // Cache informal housing to avoid timeout-prone recomputation
    var informalKey = cityName + '_informal_' + startDate + '_' + endDate;
    var informalHousingResult;
    var informalHousingImage;
    var informalHousingWards;

    if (computeCache[informalKey]) {
      // Use cached result if available
      informalHousingResult = computeCache[informalKey];
      informalHousingImage = informalHousingResult.image;
      informalHousingWards = informalHousingResult.wards;
    } else {
      // Compute fresh and cache the result
      informalHousingResult = calculateInformalHousing(wards, lulc, nightlights,
        ndvi, cityBoundary, cityConfig, urbanData);

      informalHousingImage = informalHousingResult.image;
      informalHousingWards = informalHousingResult.wards;

      // Cache for future use
      computeCache[informalKey] = informalHousingResult;
    }

    // Calculate city mean albedo (for albedo deviation/hotspot indicator)
    // Null check: use constant fallback if albedo failed to load
    var albedoClipped = urbanData.albedo
      ? urbanData.albedo.clip(cityBoundary)
      : ee.Image.constant(0.2).rename('albedo').clip(cityBoundary);

    var cityMeanAlbedoDict = albedoClipped.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: cityBoundary,
      scale: 30,  // 30m for albedo (Landsat/Sentinel-2 resolution)
      bestEffort: true,
      maxPixels: 1e9,
      tileScale: 8
    });
    var cityMeanAlbedo = ee.Number(cityMeanAlbedoDict.get('albedo'));

    // Calculate city mean ROOFTOP albedo (for rooftop-specific deviation)
    // Load GHSL Built Surface as rooftop proxy
    var ghslBuiltS = ee.Image("JRC/GHSL/P2023A/GHS_BUILT_S/2025")
      .select('built_surface')
      .clip(cityBoundary);

    // Create rooftop mask: GHSL ≥1000 m² AND WorldCover built class
    var rooftopMask = ghslBuiltS.gte(1000).and(lulc.eq(50));

    // Mask albedo to rooftops only
    var roofAlbedoClipped = albedoClipped.updateMask(rooftopMask);

    var cityMeanRoofAlbedoDict = roofAlbedoClipped.reduceRegion({
      reducer: ee.Reducer.mean(),
      geometry: cityBoundary,
      scale: 30,  // 30m for albedo
      bestEffort: true,
      maxPixels: 1e9,
      tileScale: 8
    });
    var cityMeanRoofAlbedo = ee.Number(cityMeanRoofAlbedoDict.get('albedo'));

    // ════════════════════════════════════════════════════════════════════════
    // PARALLEL COMPUTATION OPTIMIZATION
    // ════════════════════════════════════════════════════════════════════════
    // All independent layers start computing simultaneously on GEE servers
    // This provides 3-5× speedup compared to sequential execution

    // Create all independent computations as deferred objects
    var coolRoofComputation = calculateCoolRoofPriority(
      wards, lst, lulc,
      urbanData.albedo, popWards,
      cityConfig, ndvi,
      lstWards,
      cityBoundary,
      cityMeanAlbedo,
      cityMeanRoofAlbedo
    );

    var canopyGapComputation = calculateTreePlantingPriority_LowCanopy(
      wards, popWards, urbanData, cityBoundary, lstWards
    );

    var modisDay = urbanData.modisDay;
    var modisNight = urbanData.modisNight;
    var ghsl_nres = urbanData.ghsl_nres;
    var activityHeatComputation = calculateActivityHeatStress_Ward(
      wards, popWards, modisDay, modisNight, nightlights, ghsl_nres
    );

    // Wrap in FeatureCollections to trigger parallel server-side execution
    var coolRoofWards = ee.FeatureCollection(coolRoofComputation);
    var canopyGapWards = ee.FeatureCollection(canopyGapComputation);
    var activityHeatWards = ee.FeatureCollection(activityHeatComputation);

    // ════════════════════════════════════════════════════════════════════════
    // DEPENDENT COMPUTATION
    // ════════════════════════════════════════════════════════════════════════
    // Population Heat Risk needs results from above layers
    // But we wrap in ee.FeatureCollection to ensure parallel server-side execution

    var popHeatResult = calculatePopulationHeatRisk_v2(
      wards, lstWards, popWards,
      cityBoundary, cityConfig, sharedMetrics,
      informalHousingWards  // Add vulnerability data (dense housing score)
    );
    var popHeatWards = popHeatResult.wards;
    var cityPopStats = popHeatResult.cityStats;

    // ────────────────────────────────────────────────────────────────────────
    // POPULATION HEAT EXPOSURE: IPCC AR6 Framework (v2.0)
    // ────────────────────────────────────────────────────────────────────────
    // Classification is now handled internally by calculatePopulationHeatExposure_IPCC()
    // which uses:
    //   - IPCC Risk Index = (Hazard × Exposure × Vulnerability)^(1/3)
    //   - Priority Score = popAtRisk × riskIndex
    //   - CRITICAL: Risk ≥ p70 (top 30% by pure IPCC risk)
    //   - HIGH: Top 30% by Priority Score among non-CRITICAL
    // ────────────────────────────────────────────────────────────────────────

    // Already classified by the IPCC function
    var popHeatWardsPriority = popHeatWards;  // Same collection - already has priority_level


    // ────────────────────────────────────────────────────────────────────────
    // COOL ROOF PRIORITY: v3.0 Percentile-based classification (30/30/40)
    // ────────────────────────────────────────────────────────────────────────
    // Classification is now handled internally by calculateCoolRoofPriority()
    // which uses:
    //   - Built mask: ≥40% built, <20% crop, no water (NDVI/albedo removed from gates)
    //   - Eligibility: ≥50 pixels, ≥0.01 km² hot area (no built fraction threshold)
    //   - Scoring: hotBuiltArea_km² × (LST_p90 - HOT_THRESHOLD)
    //   - Classification: Percentile-based (p40/p70) → 30% High / 30% Medium / 40% Low
    // ────────────────────────────────────────────────────────────────────────

    // Already classified by the v3.0 function
    var coolRoofWardsPriority = coolRoofWards;  // Same collection - already has priority_level


    // ═════════════════════════════════════════════════════════════════════════════
    // Tree Cover Density: Priority already computed in calculateGreenBlueAccess
    // Just use the result directly
    // ═════════════════════════════════════════════════════════════════════════════

    var canopyGapWardsPriority = canopyGapWards;  // Already has priority_level set

    // ✅ SANITY CHECK: Verify High priority wards have LOW canopy (not high)
    var highWards = canopyGapWardsPriority.filter(ee.Filter.eq('priority_level', 'High'));

    // ────────────────────────────────────────────────────────────────────────
    // TREE PLANTING: City-wide resource planning statistics (2-year plan)
    // ────────────────────────────────────────────────────────────────────────
    // ✅ PERFORMANCE FIX: Removed cityTreeStats - unused dictionary with 18 aggregations
    // (11 on non-existent properties) that blocked tree planting layer rendering.
    // Tree stats are now computed lazily via loadTreePlantingStats() when needed.

    // ✅ Use percentile-based classification (city-relative, not fixed cutoffs)
    // High = ≥80th percentile, Medium = 50-80th, Low = <50th
    var activityHeatWardsPriority = addPriorityByPercentiles(
      activityHeatWards,
      'activityHeatScore',
      40,  // Medium threshold (40th percentile)
      70   // High threshold (70th percentile)
    );

    // ✅ Validation: Check priority distribution

    // Use percentile-based classification for area-fraction scores
    // P50 = Medium threshold, P80 = High threshold (top 20% of wards)
    var informalHousingWardsPriority = addPriorityByPercentiles(
      informalHousingWards,
      'informalHousingScore',
      50,   // Medium: P50
      80    // High: P80 (top 20%)
    );

    // ────────────────────────────────────────────────────────────────────────
    // COMPOSITE HEAT RISK INDEX - OPTIMIZED WITH CACHING
    // ────────────────────────────────────────────────────────────────────────
    // Check cache first to avoid redundant computation
    var compositeKey = cityName + '_composite_' + startDate + '_' + endDate;
    var heatRiskWards;

    if (ASSET_CACHE.enabled && (ASSET_CACHE.heatRiskCities.indexOf(cityName) > -1 ||
        cityHasLayerCache(cityName))) {
      // ⚡ ASSET CACHE: load the finished ward table. This skips the entire
      // multi-layer risk computation - the raster is painted from this FC and
      // the stats/priorities read its properties, so everything downstream
      // works identically but near-instantly.
      heatRiskWards = ee.FeatureCollection(cacheAssetId(cityName, 'heatrisk_wards'));
      computeCache[compositeKey] = heatRiskWards;
    } else if (computeCache[compositeKey]) {
      // Use cached result if available
      heatRiskWards = computeCache[compositeKey];
    } else {
      // Compute fresh and cache the result
      heatRiskWards = ee.FeatureCollection(calculateHeatRiskIndex_IPCC(
        wards,
        lstWards,              // Already computed
        popHeatWards,          // Computing in parallel
        canopyGapWards,        // Computing in parallel
        coolRoofWards,         // Computing in parallel
        informalHousingWards,  // Already computed
        {includeInformal: false}
      ));

      // Cache for future use
      computeCache[compositeKey] = heatRiskWards;
    }

    wardResults = {
      lstWards: lstWards,
      popHeatWards: popHeatWards,
      popHeatWardsPriority: popHeatWardsPriority,
      coolRoofWards: coolRoofWards,
      coolRoofWardsPriority: coolRoofWardsPriority,
      canopyGapWards: canopyGapWards,
      canopyGapWardsPriority: canopyGapWardsPriority,
      treeWardsPriority: canopyGapWardsPriority,  // Alias for tree planting quantification panel
      activityHeatWards: activityHeatWards,
      activityHeatWardsPriority: activityHeatWardsPriority,
      informalHousingWards: informalHousingWards,
      informalHousingWardsPriority: informalHousingWardsPriority,
      informalHousingImage: informalHousingImage,  // Pixel-level raster at 10m resolution
      heatRiskWards: heatRiskWards,  // IPCC-aligned Heat Risk Index
      // City-wide statistics for Heat Action Plan context
      cityHeatStats: cityHeatStats,
      heatExceedanceAreas: heatExceedanceAreas,
      // SUHI metrics for Surface Heat Anomaly layer
      coolReference: coolReference,  // Cool baseline temperature (°C)
      uhiStats: uhiStats,  // City-wide SUHI statistics
      uhiExceedanceAreas: uhiExceedanceAreas,  // Area above SUHI thresholds
      // Population exposure metrics for resource planning
      cityPopStats: cityPopStats,  // City-wide population and resource metrics
      cityMeanLST: cityMeanLST  // City mean LST (ee.Number) - will be updated with evaluated value
      // ✅ Removed cityTreeStats - computed lazily in loadTreePlantingStats() instead
    };

    // ═══════════════════════════════════════════════════════════════════════════════
    // PRE-COMPUTE RESOURCE STATISTICS (Single evaluation for all panels)
    // Prevents nested .evaluate() chains that cause timeouts and failures
    // ═══════════════════════════════════════════════════════════════════════════════

    // ✅ PERFORMANCE FIX: Removed massive resourceStats Dictionary that blocked layer loading
    // Statistics are now computed lazily in UI panels for fast initial rendering
    // Exceedance areas are pre-computed as lightweight arrays for UI display
    wardResults.uhiExceedanceAreasData = null;
    wardResults.heatExceedanceAreasData = null;

    // DIAGNOSTIC: Check if Population Heat Risk has real classification
    if (DEBUG_MODE) {
      popHeatWardsPriority.aggregate_histogram('priority_level').evaluate(function(h,e){
      });
    }

    uhiExceedanceAreas.evaluate(function(fc) {
      if (fc && fc.features) {
        wardResults.uhiExceedanceAreasData = fc.features.map(function(feat) {
          return feat.properties;
        });
      }
    });

    heatExceedanceAreas.evaluate(function(fc) {
      if (fc && fc.features) {
        wardResults.heatExceedanceAreasData = fc.features.map(function(feat) {
          return feat.properties;
        });
      }
    });

    // ───────────────────────────────────────────────────────────────────────────────
    // DEBUG: check whether inputs are constant + whether ward fields vary
    // ───────────────────────────────────────────────────────────────────────────────

    processWardPriorities();

    // ✅ OPTIMIZATION: filterBounds before paint (faster than clip after)
    var popHeatWardVis = paintPriority(popHeatWardsPriority.filterBounds(cityBoundary), 'Population Heat Risk');
    var coolRoofWardVis = paintPriority(coolRoofWardsPriority.filterBounds(cityBoundary), 'Cool Roof Priority');
    var greenAccessWardVis = paintPriority(canopyGapWardsPriority.filterBounds(cityBoundary), 'Tree Planting Priority');
    var activityHeatWardVis = paintPriority(activityHeatWardsPriority.filterBounds(cityBoundary), '24-Hour Heat Zones');

    // Add layers in REVERSE order (first added = top of dropdown)
    // Desired dropdown order: Land Use → Surface Temperature Hotspots
    // ⚠️ ANALYTICAL LAYERS TEMPORARILY DISABLED (Under methodological review)

    // ═══════════════════════════════════════════════════════════════════════════════
    // ANALYTICAL LAYERS - COMMENTED OUT FOR METHODOLOGICAL REVIEW
    // ═══════════════════════════════════════════════════════════════════════════════

    // Add Composite Heat Risk
    // PERFORMANCE FIX: Simplify geometry and strip properties server-side
    // This reduces memory footprint without requiring client-side evaluate
    if (wardResults && wardResults.heatRiskWards) {

      // Adaptive simplification and paint scale based on city size
      var simplifyTolerance = (cityConfig.areaKm2 > 1000) ? 100 :
                              (cityConfig.areaKm2 > 500) ? 50 : 30;
      var heatRiskScale = (cityConfig.areaKm2 > 1000) ? 150 :
                          (cityConfig.areaKm2 > 500) ? 100 : 60;

      // Simplify geometry and keep only riskIndex property (breaks dependency chain)
      var heatRiskSimplified = wardResults.heatRiskWards.map(function(f) {
        return ee.Feature(
          f.geometry().simplify({maxError: simplifyTolerance}),
          {riskIndex: f.get('riskIndex')}
        );
      });

      // Paint from simplified FC
      var heatRiskImg = paintWardChoropleth(heatRiskSimplified, 'riskIndex', heatRiskScale);

      // Add layer immediately with default visualization (ensures it appears in dropdown)
      var defaultRiskVis = {
        min: 0,
        max: 100,
        palette: params.visualization.vulnerability.palette
      };
      addLayerToMap(heatRiskImg, defaultRiskVis, 'Composite Heat Risk', false);

      // Compute actual min-max range asynchronously to refine visualization
      // P10-P90 stretch, NOT min-max: with many wards (Delhi ~250) min-max
      // lets two outlier wards own the palette ends, compressing the bulk of
      // the city into a narrow band of similar colours ("flat" look). The
      // Dense Vulnerable Housing layer already stretches P10-P90 for the same
      // reason; this matches it.
      var riskRangeStats = ee.Dictionary(
        wardResults.heatRiskWards
          .filter(ee.Filter.notNull(['riskIndex']))
          .reduceColumns(
            ee.Reducer.percentile([10, 90]).setOutputs(['p10', 'p90']),
            ['riskIndex']
          )
      );

      riskRangeStats.evaluate(function(stats) {
        if (stats && stats.p10 !== null && stats.p90 !== null &&
            stats.p90 > stats.p10) {
          var dynMin = stats.p10;
          var dynMax = stats.p90;

          // Update legend params
          params.visualization.vulnerability.min = dynMin;
          params.visualization.vulnerability.max = dynMax;

          // Update layer visualization with actual range
          var layers = mapPanel.layers();
          for (var i = 0; i < layers.length(); i++) {
            var layer = layers.get(i);
            if (layer.getName() === 'Composite Heat Risk') {
              layer.setVisParams({
                min: dynMin,
                max: dynMax,
                palette: params.visualization.vulnerability.palette
              });
              break;
            }
          }

          // Refresh legend if currently viewing this layer
          if (layerSelect.getValue() === 'Composite Heat Risk') {
            updateCompactLegend('Composite Heat Risk', legendSection);
          }
        }
      });
    }

    // Add Dense Housing Zones with DYNAMIC PERCENTILE-BASED LEGEND
    // PERFORMANCE FIX: Use async evaluate() instead of synchronous getInfo()
    // This prevents blocking the UI while computing 10m resolution percentiles (2-4 min on large cities)

    // Add layer IMMEDIATELY with default visualization (non-blocking)
    // Seeded to the range this score actually occupies. The previous 10/90
    // stretch pushed most pixels into the palette's two near-white swatches on
    // first paint, so built areas looked EMPTY until the async percentiles below
    // replaced it. These are only the pre-callback defaults; P10/P90 still win.
    var defaultInformalVis = {
      min: 20,  // Pre-callback fallback (refined to city P10 below)
      max: 65,  // Pre-callback fallback (refined to city P90 below)
      palette: params.visualization.informalHousing.palette
    };
    var informalLayer = addLayerToMap(informalHousingImage, defaultInformalVis, 'Dense Vulnerable Housing', false);

    // Calculate city-specific percentiles ASYNCHRONOUSLY in background
    var informalStats = informalHousingImage.reduceRegion({
      reducer: ee.Reducer.percentile([10, 25, 50, 75, 90]),
      geometry: cityBoundary,
      scale: 100,
      maxPixels: 1e9,
      bestEffort: true
    });

    // Refine visualization when percentiles are ready (async callback)
    informalStats.evaluate(function(p) {
      if (p) {
        var p10 = p.vulnerable_housing_p10 || 10;
        var p90 = p.vulnerable_housing_p90 || 90;

        // Update layer with refined percentile-based visualization
        var dynamicInformalVis = {
          min: p10,  // Very Sparse (bottom 10%)
          max: p90,  // Very Dense (top 10%)
          palette: params.visualization.informalHousing.palette
        };

        // Replace layer with refined visualization
        mapPanel.layers().forEach(function(layer, idx) {
          if (layer.getName() === 'Dense Vulnerable Housing') {
            layer.setVisParams(dynamicInformalVis);
            print('✓ Dense Vulnerable Housing visualization refined (p10=' + p10.toFixed(1) + ', p90=' + p90.toFixed(1) + ')');
          }
        });
      }
    });

    // Add 24-Hour Heat Zones
    addLayerToMap(activityHeatWardVis, params.visualization.economicZones, '24-Hour Heat Zones', false);

    // Add Cool Roof Priority
    addLayerToMap(coolRoofWardVis, params.visualization.CoolRoof, 'Cool Roof Priority', false);

    // Add Tree Planting Priority
    addLayerToMap(greenAccessWardVis, params.visualization.greenGaps, 'Tree Planting Priority', false);

    // Add Population Heat Risk
    addLayerToMap(popHeatWardVis, params.visualization.popExposure, 'Population Heat Risk', false);

    // Add Surface Temperature Hotspots (second in dropdown after Land Use)
    addLayerToMap(hotspot, hotspotVis, 'Surface Temperature Hotspots', false);

    if (urbanData) {
      // Add Dynamic World Built-Up Probability layer
      if (urbanData.dwBuiltProb) {
        addLayerToMap(urbanData.dwBuiltProb, params.visualization.builtProb, 'Built-Up Probability (Dynamic World)', false);
      }


      if (urbanData.imperv) {
        addLayerToMap(urbanData.imperv, params.visualization.imperv, 'Imperviousness', false);
      }

      if (urbanData.albedo) {
        // Use fixed range 0.1-0.6 for consistent visualization across all cities
        addLayerToMap(urbanData.albedo, params.visualization.albedo, 'Surface Albedo', false);
      }

      if (urbanData.population) {
        var popLog = urbanData.population.add(1).log10().multiply(100);

        // ✅ ADD LAYER IMMEDIATELY (ensures it appears in dropdown).
        // Use params.visualization.population directly - the legend reads that
        // object, so map and legend share ONE palette. A second hardcoded ramp
        // here previously made the legend bar subtly different from the map.
        addLayerToMap(popLog, params.visualization.population, 'Population Count', false);

        // ✅ OPTIONAL: Calculate percentiles asynchronously to refine visualization later
        // (This is just for optimization, not required for layer to appear)
        var popVis = popLog.clip(cityBoundary).reduceRegion({
          reducer: ee.Reducer.percentile([2, 98]),
          geometry: reducerGeom,
          scale: 100,
          crs: 'EPSG:4326',
          bestEffort: true,
          maxPixels: 1e8,
          tileScale: 8
        });

        popVis.evaluate(function(stats) {
          // If percentiles succeed, we could update the layer visualization here
          // (Currently disabled to keep layer stable in dropdown)
          // This async operation no longer controls whether layer appears
        });
      }
    }

    // Optimized ward boundaries - outline only (faster rendering)
    var wardsSimplified = wards.map(function(f) {
      return f.simplify(100);  // Simplify geometry to 100m tolerance
    });
    var wardOutlines = ee.Image().byte().paint({
      featureCollection: wardsSimplified,
      color: 1,
      width: 1
    });

    mapPanel.addLayer(
      wardOutlines,
      {palette: ['000000'], min: 0, max: 1, opacity: 0.6},
      'Ward Boundaries',
      true
    );

    // Define layer order explicitly - MAIN ANALYTICAL LAYERS ONLY
    // (Other layers remain accessible via map layer toggle button)
    var desiredLayerOrder = [
      'Land Use',
      'Surface Temperature Hotspots',
      'Dense Vulnerable Housing',
      'Population Heat Risk',
      'Cool Roof Priority',
      'Tree Planting Priority',
      '24-Hour Heat Zones',
      'Composite Heat Risk'
    ];

    // ═══════════════════════════════════════════════════════════════════════
    // LAYERS NOT IN DROPDOWN (accessible via map toggle only):
    // - Built-Up Probability (Dynamic World)
    // - Land Surface Temperature (Daytime, clear-sky)
    // - Surface Albedo
    // - Imperviousness
    // - Population Count
    // - Nighttime Light Intensity
    // ═══════════════════════════════════════════════════════════════════════

    // Filter to only include layers that actually exist on the map
    var availableLayers = [];
    var layerNamesOnMap = {};

    mapPanel.layers().forEach(function(layer) {
      var name = layer.getName();
      layerNamesOnMap[name] = true;
    });

    // Add layers in desired order if they exist
    desiredLayerOrder.forEach(function(name) {
      if (layerNamesOnMap[name]) {
        availableLayers.push(name);
      }
    });

    layerSelect.items().reset(availableLayers);

    // Set default to Land Use layer
    var defaultLayer = 'Land Use';
    if (availableLayers.length > 0 && layerNamesOnMap[defaultLayer]) {
      layerSelect.setValue(defaultLayer, false);
      // Use setTimeout to ensure UI is fully initialized before updating
      ui.util.setTimeout(function() {
        updateInfo(defaultLayer);
      }, 100);
    } else if (availableLayers.length > 0) {
      layerSelect.setValue(availableLayers[0], false);
      ui.util.setTimeout(function() {
        updateInfo(availableLayers[0]);
      }, 100);
    }

    ui.util.setTimeout(function() {
      try {
        mapPanel.remove(progressLabel);
      } catch(err) {}

      citySelect.setDisabled(false);
      computationState.isRunning = false;

      // cityLabel.setValue('Analysis complete for: ' + cityName);  // Static label now
    }, 2000);

  } catch (e) {
    // Log error details
    print('❌ ERROR in runAnalysis: ' + e);

    citySelect.setDisabled(false);
    computationState.isRunning = false;

    try {
      mapPanel.remove(progressLabel);
    } catch(err) {}

    wardResults = {
      lstWards: createDefaultWardResults(wards),
      popHeatWards: createDefaultWardResults(wards),
      popHeatWardsPriority: createDefaultWardResults(wards),
      coolRoofWards: createDefaultWardResults(wards),
      coolRoofWardsPriority: createDefaultWardResults(wards),
      canopyGapWards: createDefaultWardResults(wards),
      canopyGapWardsPriority: createDefaultWardResults(wards),
      treeWardsPriority: createDefaultWardResults(wards),  // Alias for tree planting quantification panel
      activityHeatWards: createDefaultWardResults(wards),
      activityHeatWardsPriority: createDefaultWardResults(wards),
      informalHousingWards: createDefaultWardResults(wards),
      informalHousingWardsPriority: createDefaultWardResults(wards),
      // Without this the Composite panel said "Loading compound risk data..."
      // forever after a failed run (loadHeatRiskStats returns early).
      heatRiskWards: createDefaultWardResults(wards)
    };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 9B. EXPORT WARD STATISTICS FUNCTION
// ───────────────────────────────────────────────────────────────────────────────

/**
 * ⚡ ASSET CACHE EXPORT — Code Editor only (Export.* is unavailable in apps).
 * Queues 2 tasks for the CURRENT city: the 30m Landsat composite and the 10m
 * albedo composite, materialized through the exact same functions the app
 * uses live, so cached and computed pixels are identical by construction.
 * After both tasks complete, add the city to ASSET_CACHE.cities and redeploy.
 */
/**
 * Ensure the cache folder exists (Code Editor only). Export tasks fail at Run
 * time with "Permission 'earthengine.assets.get' denied ... (or it may not
 * exist)" when their parent folder is missing, so create it up front.
 */
function ensureCacheFolder() {
  var exists = false;
  try {
    exists = !!ee.data.getAsset(ASSET_CACHE.root);
  } catch (e) {
    exists = false;
  }
  if (exists) return true;
  try {
    ee.data.createFolder(ASSET_CACHE.root);
    print('⚡ Created asset folder: ' + ASSET_CACHE.root);
    return true;
  } catch (e1) {
    try {
      // Older API signature fallback
      ee.data.createAsset({type: 'Folder'}, ASSET_CACHE.root);
      print('⚡ Created asset folder: ' + ASSET_CACHE.root);
      return true;
    } catch (e2) {
      print('⚡ Could not create ' + ASSET_CACHE.root + ' automatically.');
      print('⚡ Create it manually: Assets tab → NEW → Folder, with the path');
      print('⚡ exactly ' + ASSET_CACHE.root + ', then retry.');
      return false;
    }
  }
}

function exportCityCacheAssets() {
  if (!ensureCacheFolder()) return;
  if (!cityBoundary) {
    print('⚡ Run a city analysis first, then export.');
    return;
  }

  // cityBoundary is already an ee.Geometry (wards.geometry()), so call
  // bounds() directly - .geometry() only exists on Features/Collections.
  var exportRegion = cityBoundary.bounds();
  var safeCity = cityName;  // all configured city names are single words
  var queued = 0;

  // ── Composites (skip if this city's composites are already cached) ──
  if (!cityIsPrecomputed(safeCity)) {
    var comp = loadLandsatData(cityBoundary, startDate, endDate, summerFilter)
      .toFloat();
    var albedoImg = loadSentinel2ForAlbedo(cityBoundary, startDate, endDate, summerFilter)
      .select('albedo').toFloat();

    Export.image.toAsset({
      image: comp,
      description: safeCity + '_landsat_composite_' + ASSET_CACHE.version,
      assetId: cacheAssetId(safeCity, 'landsat_composite'),
      region: exportRegion,
      scale: 30,             // matches every downstream reduction's pinned scale
      crs: 'EPSG:4326',
      maxPixels: 1e13
    });
    Export.image.toAsset({
      image: albedoImg,
      description: safeCity + '_albedo_' + ASSET_CACHE.version,
      assetId: cacheAssetId(safeCity, 'albedo'),
      region: exportRegion,
      scale: 10,             // albedo's native working scale
      crs: 'EPSG:4326',
      maxPixels: 1e13
    });
    queued += 2;
  } else {
    print('⚡ Composites already cached for ' + safeCity + ' — skipping those.');
  }

  // ── Heat-risk ward table (the exact finished layer, with all properties) ──
  // The FC's lazy graph exists only after this city's analysis has run, which
  // the cityBoundary check above guarantees. If composites are cached, this
  // table computes FROM them - identical output, faster export.
  if (ASSET_CACHE.heatRiskCities.indexOf(safeCity) > -1) {
    print('⚡ Heat-risk table already cached for ' + safeCity + ' — skipping.');
  } else if (wardResults && wardResults.heatRiskWards) {
    Export.table.toAsset({
      collection: wardResults.heatRiskWards,
      description: safeCity + '_heatrisk_wards_' + ASSET_CACHE.version,
      assetId: cacheAssetId(safeCity, 'heatrisk_wards')
    });
    queued += 1;
  } else {
    print('⚡ Heat-risk wards not ready yet — let the analysis finish, then retry.');
  }

  // ── Full layer-results bundle: every layer's finished ward table plus the
  //    10m informal-housing raster. Exported from the SAME session globals the
  //    app just built, so cached and live results are identical by construction.
  if (cityHasLayerCache(safeCity)) {
    print('⚡ Layer bundle already cached for ' + safeCity + ' — skipping.');
  } else if (wardResults) {
    var tableProducts = [
      ['lst_wards',      wardResults.lstWards],
      ['pop_wards',      wardResults.popHeatWards],
      ['coolroof_wards', wardResults.coolRoofWards],
      ['tree_wards',     wardResults.canopyGapWards],
      ['activity_wards', wardResults.activityHeatWards],
      ['informal_wards', wardResults.informalHousingWards]
    ];
    tableProducts.forEach(function(p) {
      if (!p[1]) {
        print('⚡ ' + p[0] + ' not available this session — skipped.');
        return;
      }
      Export.table.toAsset({
        collection: ee.FeatureCollection(p[1]),
        description: safeCity + '_' + p[0] + '_' + ASSET_CACHE.version,
        assetId: cacheAssetId(safeCity, p[0])
      });
      queued += 1;
    });

    if (wardResults.informalHousingImage) {
      Export.image.toAsset({
        image: ee.Image(wardResults.informalHousingImage).toFloat(),
        description: safeCity + '_informal_image_' + ASSET_CACHE.version,
        assetId: cacheAssetId(safeCity, 'informal_image'),
        region: exportRegion,
        scale: 10,
        crs: 'EPSG:4326',
        maxPixels: 1e13
      });
      queued += 1;
    }
  }

  if (queued > 0) {
    print('⚡ ' + queued + ' export task(s) queued for ' + safeCity + ' — run them in the Tasks tab.');
    print('⚡ Composites done → ASSET_CACHE.cities. Heat-risk table alone →');
    print('⚡ heatRiskCities. FULL bundle (all 8 tasks) done → layerCities');
    print('⚡ (which covers heat risk too). Then redeploy.');
  }
}

/**
 * ⚡ BATCH EXPORT — queue cache exports for EVERY city in one click.
 * Task definition is lazy (no computation happens until each task runs), so
 * looping all 15 cities here is cheap. Each city gets the same two products
 * as exportCityCacheAssets, built through the same loader functions.
 *
 * Region note: runAnalysis uses cityBoundary = wards.geometry(); the ward-ID
 * normalization in loadBoundaries only edits PROPERTIES, so
 * ee.FeatureCollection(assetPath).geometry() is the identical region and the
 * exported pixels match what the app computes live.
 */
function exportAllCityCacheAssets() {
  if (!ensureCacheFolder()) return;
  var savedCity = cityName;
  var queued = 0, skipped = [];
  try {
    Object.keys(cityConfigs).forEach(function(city) {
      if (cityIsPrecomputed(city)) {
        skipped.push(city);
        return;
      }
      // Loaders key computeCache and asset paths off the GLOBAL cityName.
      cityName = city;
      var cfg = cityConfigs[city];
      var boundary = ee.FeatureCollection(cfg.assetPath).geometry();
      var exportRegion = boundary.bounds();

      var comp = loadLandsatData(boundary, startDate, endDate, summerFilter)
        .toFloat();
      var albedoImg = loadSentinel2ForAlbedo(boundary, startDate, endDate, summerFilter)
        .select('albedo').toFloat();

      Export.image.toAsset({
        image: comp,
        description: city + '_landsat_composite_' + ASSET_CACHE.version,
        assetId: cacheAssetId(city, 'landsat_composite'),
        region: exportRegion,
        scale: 30,
        crs: 'EPSG:4326',
        maxPixels: 1e13
      });
      Export.image.toAsset({
        image: albedoImg,
        description: city + '_albedo_' + ASSET_CACHE.version,
        assetId: cacheAssetId(city, 'albedo'),
        region: exportRegion,
        scale: 10,
        crs: 'EPSG:4326',
        maxPixels: 1e13
      });
      queued += 2;
    });
  } finally {
    cityName = savedCity;  // never leave the app pointing at the wrong city
  }

  print('⚡ Queued ' + queued + ' export tasks (' + (queued / 2) + ' cities x 2).');
  if (skipped.length) print('⚡ Skipped (already cached): ' + skipped.join(', '));
  print('⚡ Open the Tasks tab and click Run on each task. When ALL have');
  print('⚡ finished, replace ASSET_CACHE.cities with the full list and redeploy:');
  print("⚡ cities: ['Ayodhya','Varanasi','Bhubaneswar','Agra','Kolkata','Surat','Lucknow','Chennai','Jaipur','Ahmedabad','Mumbai','Hyderabad','Bangalore','Delhi','Bhopal']");
}

function exportWardStatistics() {
  if (!cityName) {
    return;
  }

  if (!wardResults || !wardResults.lstWards) {
    return;
  }


  // Join all ward data from different layers. joinWardResults overwrites on
  // conflict, so each layer's own priority_score / priority_level is first
  // copied to a layer-tagged name (pop_priority_level, ...) and the tagged
  // columns are exported; previously the last join (activity) stood in for
  // every layer's classification. The heat-risk and informal tables were
  // never joined at all, so their columns exported empty.
  var tagPriority = function(fc, tag) {
    return ee.FeatureCollection(fc).map(function(f) {
      var d = f.toDictionary(['priority_score', 'priority_level']);  // drops absent/null
      var keys = d.keys();
      return f.set(d.rename(keys, keys.map(function(k) {
        return ee.String(tag).cat('_').cat(ee.String(k));
      })));
    });
  };

  var exportData = wards;
  var joinSpecs = [
    ['lst',      wardResults.lstWards],
    ['pop',      wardResults.popHeatWardsPriority || wardResults.popHeatWards],
    ['coolroof', wardResults.coolRoofWardsPriority || wardResults.coolRoofWards],
    ['tree',     wardResults.canopyGapWardsPriority || wardResults.canopyGapWards],
    ['activity', wardResults.activityHeatWardsPriority || wardResults.activityHeatWards],
    ['informal', wardResults.informalHousingWardsPriority || wardResults.informalHousingWards],
    ['heatrisk', wardResults.heatRiskWards]
  ];
  joinSpecs.forEach(function(spec) {
    if (spec[1]) {
      exportData = joinWardResults(exportData, tagPriority(spec[1], spec[0]), 'WARD_NO', spec[0]);
    }
  });

  // Select only mean values for inter-ward comparison (not within-ward variability)
  // Reviewer needs to compare wards against each other, not analyze pixel variance within wards
  var propertiesToExport = [
    // ═══════════════════════════════════════════════════════════════════
    // IDENTIFIERS
    // ═══════════════════════════════════════════════════════════════════
    'state', 'city', 'WARD_NO', 'ward_name', 'wardArea_km2',

    // ═══════════════════════════════════════════════════════════════════
    // TEMPERATURE (LST) - Essential Statistics Only
    // ═══════════════════════════════════════════════════════════════════
    'LST_mean', 'LST_min', 'LST_max', 'LST_hotspot',

    // ═══════════════════════════════════════════════════════════════════
    // URBAN HEAT ISLAND - All Land
    // ═══════════════════════════════════════════════════════════════════
    'UHI_all_mean', 'UHI_all_stdDev',

    // ═══════════════════════════════════════════════════════════════════
    // POPULATION - Totals + Density
    // ═══════════════════════════════════════════════════════════════════
    'totalPop', 'popDensity',

    // ═══════════════════════════════════════════════════════════════════
    // ALBEDO (Built-Area Reflectance) - Used for Cool Roof Priority
    // ═══════════════════════════════════════════════════════════════════
    'builtAlbedo_mean', 'builtAlbedo_min', 'builtAlbedo_max',

    // ═══════════════════════════════════════════════════════════════════
    // NIGHTTIME + SUPPLEMENTAL INPUT VARIABLES
    // ═══════════════════════════════════════════════════════════════════
    'ntl_mean', 'nightLST_mean',
    'ndvi_mean', 'treeProb_mean', 'vegDeficit_mean',
    'dwBuiltProb_mean', 'ghslDensity_mean', 'dimness_mean',

    // ═══════════════════════════════════════════════════════════════════
    // LAYER OUTPUT SCORES (0-100) & PRIORITY CLASSIFICATIONS
    // ═══════════════════════════════════════════════════════════════════
    // Population Heat Risk
    'riskScore',
    // NOTE: popAtRisk and exposureRate removed - not computed by current pipeline

    // Cool Roof Opportunity
    'coolRoofPriorityScore', 'darkBuiltArea_m2', 'potentialCooling_C',
    // NOTE: estimatedCost_Lakhs removed - not computed by current pipeline
    // NOTE: darkRoofArea_km2 renamed to darkBuiltArea_m2 (units: square meters)

    // Tree Planting Priority
    'currentCanopy_pct', 'canopyDeficit_ha', 'treesToCloseGap', 'plantableFraction',
    'treesNeeded', 'saplingsToPlant', 'totalCost_Lakhs',

    // 24-Hour Heat Zones
    'activityHeatScore', 'dayLST', 'nightLST', 'avgLST_24h',

    // Dense Housing Zones
    'informalHousingScore',

    // Composite Heat Risk
    'riskIndex', 'hazardIndex', 'exposureIndex', 'vulnerabilityIndex',

    // Priority classification PER LAYER (High/Medium/Low), tagged at join
    // time so no layer's classification overwrites another's
    'pop_priority_level', 'coolroof_priority_level', 'tree_priority_score',
    'tree_priority_level', 'activity_priority_level', 'informal_priority_level',
    'heatrisk_priority_level'
  ];

  // ═══════════════════════════════════════════════════════════════════════════════
  // ADD VARIABLE DEFINITIONS ROW (First row in CSV explains each column)
  // ═══════════════════════════════════════════════════════════════════════════════
  var definitionsRow = ee.Feature(null, {
    // Identifiers
    'state': 'State name',
    'city': 'City name',
    'WARD_NO': 'DEFINITIONS - Variable descriptions below',
    'ward_name': 'Ward name/identifier',
    'wardArea_km2': 'Ward area (km²)',

    // LST - Essential Statistics
    'LST_mean': 'Land Surface Temp mean (°C) - Landsat 30m daytime clear-sky',
    'LST_min': 'LST minimum (°C) - coolest spot in ward',
    'LST_max': 'LST maximum (°C) - hottest spot in ward',
    'LST_hotspot': 'Temperature hotspot (°C) - deviation from city mean LST',

    // UHI All Land
    'UHI_all_mean': 'UHI mean (°C) - deviation from cool vegetation reference',
    'UHI_all_stdDev': 'UHI standard deviation (°C) - within-ward variability',

    // Population
    'totalPop': 'Total ward population (people) - WorldPop Global 2 (R2025A) 100m resolution with building footprint detection',
    'popDensity': 'Population density (people/km²)',

    // Albedo (Built-Area Reflectance) - Used for Cool Roof Priority
    'builtAlbedo_mean': 'Built-area albedo mean (0-1) - SUM(albedo × built) / SUM(built) - Bonafoni & Sekertekin 2020 (S2) / Liang 2001 (L8/9)',
    'builtAlbedo_min': 'Built-area albedo minimum (0-1) - darkest built surface in ward',
    'builtAlbedo_max': 'Built-area albedo maximum (0-1) - brightest built surface in ward',

    // Nighttime & Supplemental Input Variables
    'ntl_mean': 'Nightlight radiance mean (nW/cm²/sr) - VIIRS DNB 500m monthly',
    'nightLST_mean': 'MODIS nighttime LST mean (°C) - Terra+Aqua 1km composite',
    'ndvi_mean': 'NDVI vegetation index mean (0-1) - Landsat 30m (NIR-Red)/(NIR+Red)',
    'treeProb_mean': 'Tree probability mean (%) - Dynamic World 10m',
    'vegDeficit_mean': 'Vegetation deficit score (0-100) - inverse of tree+shrub+grass coverage',
    'dwBuiltProb_mean': 'Dynamic World built probability mean (%) - 10m built band',
    'ghslDensity_mean': 'GHSL built density normalized (0-100) - JRC Built-S 2025 P5-P95',
    'dimness_mean': 'Nightlight dimness score (0-100) - inverse VIIRS brightness',

    // Layer Output Scores (0-100) & Priority Classifications
    'riskScore': 'Population Heat Risk Score (0-100) - IPCC framework (H×E×V)^(1/3)',
    'coolRoofPriorityScore': 'Cool Roof Priority Score (0-100) - albedo deficit × LST × built area',
    'darkBuiltArea_m2': 'Dark built-up area needing coating (m²) - albedo <0.15 within WorldCover built class',
    'potentialCooling_C': 'Potential cooling from cool roofs (°C)',
    'tree_priority_score': 'Tree Planting Priority Score (0-100) - canopy deficit × exposed population × heat',
    'currentCanopy_pct': 'Current tree canopy coverage (%)',
    'canopyDeficit_ha': 'Canopy missing in built-up area (ha) = built ha × (20% target − current canopy)',
    'treesToCloseGap': 'Trees that would close the gap outright = deficit ha × 400 trees/ha',
    'plantableFraction': 'Share of the deficit area realistically plantable (High 0.20 / Medium 0.25 / Low 0.30)',
    'treesNeeded': 'Trees to establish = deficit ha × plantable fraction × 400 trees/ha',
    'saplingsToPlant': 'Saplings to procure = trees to establish × 1/0.74 survival buffer',
    'totalCost_Lakhs': 'Total greening cost (₹ lakh) = saplings × ₹750 (sapling + labour + 3-year maintenance)',
    'activityHeatScore': '24-Hour Heat Zone Score (0-100) - heat × population × NRES-filtered nightlights',
    'dayLST': 'Daytime LST (°C) - MODIS Terra+Aqua 1km',
    'nightLST': 'Nighttime LST (°C) - MODIS Terra+Aqua 1km',
    'avgLST_24h': 'Average 24-hour LST (°C)',
    'informalHousingScore': 'Dense Housing Score (0-100) - (Volume × VegDeficit)^(1/2)',
    'riskIndex': 'Composite Heat Risk Index (relative, roughly 0-4, higher = worse) = (hazardIndex × exposureIndex × vulnerabilityIndex)^(1/3); built from 6 inputs',
    'hazardIndex': 'Hazard component (0-2) = normalised day heat + night heat',
    'exposureIndex': 'Exposure component (unitless, ln of ward population, roughly 5-13)',
    'vulnerabilityIndex': 'Vulnerability component (0-3) = canopy gap + dense housing + dark roofs',
    'pop_priority_level': 'Population Heat Risk class (High/Medium/Low) - percentile-based',
    'coolroof_priority_level': 'Cool Roof Priority class (High/Medium/Low) - percentile-based',
    'tree_priority_level': 'Tree Planting Priority class (High/Medium/Low) - percentile-based',
    'activity_priority_level': '24-Hour Heat Zone class (High/Medium/Low) - percentile-based',
    'informal_priority_level': 'Dense Housing class (High/Medium/Low) - percentile-based',
    'heatrisk_priority_level': 'Composite Heat Risk class (High/Medium/Low) - percentile-based'
  });

  // Prepend definitions row to export data
  exportData = ee.FeatureCollection([definitionsRow]).merge(exportData);

  // Create filename with timestamp (client-side: same 'YYYY-MM-dd_HHmm' UTC
  // format as before, without the blocking getInfo() round trip)
  var timestamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  var filename = 'CHAITRA_WardStats_' + cityName + '_' + timestamp;

  // Export to Google Drive
  Export.table.toDrive({
    collection: exportData,
    description: 'CHAITRA_Ward_Statistics_' + cityName,
    folder: 'CHAITRA_Exports',
    fileNamePrefix: filename,
    fileFormat: 'CSV',
    selectors: propertiesToExport
  });

}

// ───────────────────────────────────────────────────────────────────────────────
// 10. UI SETUP FUNCTION

function setupUI() {
  ui.root.clear();

  mapPanel = ui.Map();
  // Center on India with proper coordinates
  // Coordinates: 78.9629°E, 20.5937°N (Central India) at zoom level 5
  mapPanel.setCenter(78.9629, 20.5937, 5);
  mapPanel.style().set('cursor', 'crosshair');
  mapPanel.setOptions('SATELLITE');

  // NOTE: do NOT attach mapPanel to ui.root here. Early attachment (tried
  // Sep 2026, both as clear()+add() and widgets().reset()) races the map's
  // own initialization and throws the internal GEE error "Cannot read
  // properties of null (reading 'headerMap')" from unrelated lines. The map
  // is attached at the END of setupUI with the sidebar - the original,
  // known-good order. The India setCenter above still applies on attach.

  // Opening message: shown over the India-wide view for 7 seconds at startup
  // Opening splash removed: it was added to cover the slow Agra startup,
  // which the layer cache has eliminated - the box only delayed the map.

  mapPanel.setControlVisibility({
    layerList: true,
    zoomControl: true,
    mapTypeControl: true,
    fullscreenControl: true,
    drawingToolsControl: false
  });

  // Responsive panel width based on screen size
  sidePanel = ui.Panel({
    style: {
      position: 'top-right',
      width: '340px',  // Default for desktop
      padding: '16px',
      backgroundColor: '#ffffff',
      maxHeight: '90%',
      border: '1px solid #000000'
    }
  });

  // ===== CHAITRA LOGO (SVG as Base64) =====
  var LOGO_SVG_BASE64 = 'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiPz48c3ZnIGlkPSJMYXllcl8xIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyMTIuODMgMTA0LjQ3Ij48ZGVmcz48c3R5bGU+LmNscy0xe2ZpbGw6IzZkMmQxZTt9PC9zdHlsZT48L2RlZnM+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMjcuMjgsNzYuMzZjLTEuNjgsMC0zLjY1LS40LTUuOTItMS4yMS0yLjI3LS44MS00LjUtMS44NC02LjY5LTMuMS0yLjE5LTEuMjYtMy45OC0yLjU3LTUuMzktMy45NS0xLjQxLTEuMzgtMi4xMS0yLjYzLTIuMTEtMy43NywwLTEuNTUuMS0zLjU0LjMxLTUuOTcuMjEtMi40Mi4zMS00Ljk4LjMxLTcuNjd2LTE1LjUzYzAtNS44NiwxLjIxLTEwLjA0LDMuNjQtMTIuNTIsMi40Mi0yLjQ4LDUuNzktMy43MiwxMC4xLTMuNzIsMS44LDAsMy42NC40OCw1LjUyLDEuNDQsMS44OC45NiwzLjY1LDIuMTUsNS4zLDMuNTksMS42NSwxLjQ0LDIuOTgsMi45MywzLjk5LDQuNDksMS4wMiwxLjU2LDEuNTMsMi45MywxLjUzLDQuMTMsMCwxLjM4LS4wOSwyLjkyLS4yNyw0LjYyLS4xOCwxLjcxLS40OCwzLjI4LS45LDQuNzFsLTguODktMi4wNmMuMjQtMS40NC40Ni0yLjk2LjY3LTQuNTguMjEtMS42Mi4zMS0zLjI5LjMxLTUuMDMsMC0xLjk3LTEuMDUtMi45Ni0zLjE0LTIuOTYtMi42MywwLTQuNzMuNzMtNi4yOCwyLjItMS41NiwxLjQ3LTIuMzMsMy45Ni0yLjMzLDcuNDl2MTcuMzJjMCwyLjk5LS4wOCw1LjM5LS4yMiw3LjE4LS4xNSwxLjc5LS4yMiwzLjA1LS4yMiwzLjc3LDAsMi4xLDEuMDgsMy4xNCwzLjIzLDMuMTQsMi44MSwwLDUuMTItLjY2LDYuOTEtMS45NywxLjgtMS4zMiwzLjM1LTMuNDEsNC42Ny02LjI4aDEuMDhsNy40NSw0LjMxYy0xLjI2LDMuODMtMi45OCw2Ljc4LTUuMTYsOC44NC0yLjE5LDIuMDYtNC42OCwzLjEtNy41LDMuMVoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik01My4yMyw3Ny4wOGMtMy44My0xLjQ0LTYuNzgtMi43NC04Ljg0LTMuOXMtMy4xLTIuMjMtMy4xLTMuMTljMC0uODQuMS0yLjE0LjMxLTMuOS4yMS0xLjc2LjMxLTMuNDkuMzEtNS4xNnYtMjQuMDVjMC0zLjU5LjEzLTYuOS40LTkuOTIuMjctMy4wMi42MS01LjQzLDEuMDMtNy4yM2gtMy44NmwtNC45NC01LjgzLjYzLTEuNDRoMTEuNjdsNS4zLDYuODJjLS40MiwyLjIxLS43NSw0LjY4LS45OSw3LjQxLS4yNCwyLjcyLS4zNiw1LjU1LS4zNiw4LjQ4Ljk2LS45NiwyLjE0LTEuNzEsMy41NS0yLjI0LDEuNDEtLjU0LDIuODktLjgxLDQuNDQtLjgxLDEuMzIsMCwyLjcyLjQ4LDQuMjIsMS40NCwxLjUuOTYsMi45MiwyLjEyLDQuMjYsMy41LDEuMzUsMS4zOCwyLjQ1LDIuNzQsMy4zMiw0LjA4Ljg3LDEuMzUsMS4zLDIuNDQsMS4zLDMuMjgsMCwxLjUtLjA2LDMuMzUtLjE4LDUuNTctLjEyLDIuMjEtLjE4LDQuMDEtLjE4LDUuMzl2Ni41NWMwLDIuMTUtLjA5LDQuMDUtLjI3LDUuNy0uMTgsMS42NS0uMjcsMi44OS0uMjcsMy43MywwLC42LjIyLDEuMDYuNjcsMS4zOS40NS4zMywxLjU3Ljk3LDMuMzcsMS45M2wtMS4wOCwyLjQyYy0zLjgzLTEuNDQtNi43OC0yLjc0LTguODQtMy45cy0zLjEtMi4yMy0zLjEtMy4xOWMwLS44NC4xLTIuMTQuMzEtMy45LjIxLTEuNzYuMzEtMy40OS4zMS01LjE2di00LjY3YzAtMS45MS4wNi00LjEuMTgtNi41NS4xMi0yLjQ1LjE4LTQuNjEuMTgtNi40NiwwLTEuMi0uMTUtMi0uNDUtMi40Mi0uMy0uNDItLjk2LS42My0xLjk3LS42My0zLjM1LDAtNS44Mi44NS03LjQxLDIuNTYtMS41OSwxLjcxLTIuMzgsNC4wNS0yLjM4LDcuMDV2MTIuMTJjMCwyLjE1LS4wOSw0LjA1LS4yNyw1LjctLjE4LDEuNjUtLjI3LDIuODktLjI3LDMuNzMsMCwuNi4yMiwxLjA2LjY3LDEuMzkuNDUuMzMsMS41Ny45NywzLjM3LDEuOTNsLTEuMDgsMi40MloiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xMDYuMzYsNzYuNjNjLTEuNDQtLjQ4LTIuNzUtLjk3LTMuOTUtMS40OC0xLjItLjUxLTIuMzMtMS4wNi0zLjQxLTEuNjYtLjg0Ljg0LTEuODQsMS41MS0zLjAxLDIuMDItMS4xNy41MS0yLjUuNzYtMy45OS43Ni0xLjAyLDAtMi41LS4zMy00LjQ0LS45OS0xLjk0LS42Ni0zLjk0LTEuNTEtNS45Ny0yLjU2LTIuMDQtMS4wNS0zLjc2LTIuMjEtNS4xNi0zLjUtMS40MS0xLjI5LTIuMTEtMi41Ni0yLjExLTMuODIsMC0xLjU2LjAxLTIuOTUuMDQtNC4xNy4wMy0xLjIzLjA0LTEuOTYuMDQtMi4yLDAtMy41My45MS02LjAzLDIuNzQtNy41LDEuODItMS40Niw0LjM4LTIuMiw3LjY3LTIuMiwxLjY3LDAsMy40Ny4xMiw1LjM5LjM2LDEuOTEuMjQsMy40Ny41MSw0LjY3LjgxLjA2LTEuNjcuMS0zLjI4LjEzLTQuOC4wMy0xLjUzLjA0LTIuNjguMDQtMy40NiwwLS42Ni0uMTgtMS4xNC0uNTQtMS40NC0uMzYtLjMtMS4wMi0uNDUtMS45Ny0uNDUtMi4zMywwLTQuMzEuMTgtNS45Mi41NC0xLjYyLjM2LTMuMTQuOTYtNC41OCwxLjc5aC0xLjcxbC01LjgzLTguNTMuNzItMS40NGgxNC45OWMxLjIsMCwyLjU2LjQ2LDQuMDgsMS4zOSwxLjUzLjkzLDMuMDQsMi4wOCw0LjUzLDMuNDYsMS41LDEuMzgsMi43MiwyLjc4LDMuNjgsNC4yMi45NiwxLjQ0LDEuNDQsMi42OSwxLjQ0LDMuNzcsMCwxLjk3LS4wNiw0LjMxLS4xOCw3LS4xMiwyLjY5LS4yNCw1LjQzLS4zNiw4LjIxLS4xMiwyLjc4LS4xOCw1LjMxLS4xOCw3LjU4LDAsMS44LjMsMy4wNC45LDMuNzMuNi42OSwxLjczLDEuMzYsMy40MSwyLjAybC0xLjE3LDIuNTFaTTgzLjIsNjUuNDFjMCwxLjUuMjcsMi40NC44MSwyLjgzLjU0LjM5LDEuMi41OCwxLjk3LjU4LDIuNDUsMCw0LjUtLjY0LDYuMTUtMS45MywxLjY1LTEuMjksMi40Ny0zLjMxLDIuNDctNi4wNiwwLS41NC4wMS0xLjIuMDQtMS45OC4wMy0uNzguMDQtMS42NC4wNC0yLjYtLjY2LS4xOC0xLjQ3LS4zLTIuNDItLjM2LS45Ni0uMDYtMS44My0uMDktMi42LS4wOS0yLjE1LDAtMy43Ny40OC00Ljg1LDEuNDQtMS4wOC45Ni0xLjYyLDIuNjMtMS42Miw1LjAzdjMuMTRaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTE4LjkzLDc3LjI2Yy0zLjgzLTEuNDQtNi43OC0yLjc0LTguODQtMy45LTIuMDYtMS4xNy0zLjEtMi4yMy0zLjEtMy4xOSwwLS44NC4xLTIuMTQuMzEtMy45MS4yMS0xLjc2LjMxLTMuNDguMzEtNS4xNnYtMTIuODNjMC0xLjU2LjA3LTMuMDEuMjItNC4zNS4xNS0xLjM1LjQtMi41My43Ni0zLjU1aC0yLjk2bC00Ljc2LTYuMS42My0xLjUzaDExLjQ5bDUuMjEsN2MtLjcyLjk2LTEuMTgsMi4xNS0xLjM5LDMuNTktLjIxLDEuNDQtLjMxLDMuMjYtLjMxLDUuNDh2MTMuMjhjMCwyLjE1LS4wOSw0LjA1LS4yNyw1LjctLjE4LDEuNjUtLjI3LDIuODktLjI3LDMuNzIsMCwuNi4yMiwxLjA2LjY3LDEuMzkuNDUuMzMsMS41Ny45NywzLjM3LDEuOTNsLTEuMDgsMi40MlpNMTEwLjk0LDI2LjcybC01LjkyLTYuMzd2LS45YzEuNjItMi4xNSwzLjgtNC4wNCw2LjU1LTUuNjVsNS45Miw2LjE5LS4wOSwxLjA4Yy0xLjIuODQtMi4zMiwxLjc3LTMuMzcsMi43OC0xLjA1LDEuMDItMi4wOCwxLjk3LTMuMSwyLjg3WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTEzNi4yNSw3Ni4zNmMtLjksMC0yLjEyLS4zNC0zLjY4LTEuMDMtMS41Ni0uNjktMy4xNC0xLjU4LTQuNzYtMi42OS0xLjYyLTEuMTEtMi45OS0yLjI3LTQuMTMtMy41LTEuMTQtMS4yMy0xLjcxLTIuNDEtMS43MS0zLjU1LDAtLjY2LjAzLTEuMzUuMDktMi4wNi4wNi0uNzIuMTUtMS42Ni4yNy0yLjgzLjEyLTEuMTcuMjEtMi43NC4yNy00LjcxLjA2LTEuOTcuMDktNC41NS4wOS03Ljcydi0zLjc3YzAtMS4zMi0uMDMtMi42OS0uMDktNC4xM2gtMS42MmwtNC41OC02LjAxLjYzLTEuNDRjMy4xNy0uMzYsNS4xOC0xLjMyLDYuMDEtMi44Ny44NC0xLjU2LDEuMjYtMy45MiwxLjI2LTcuMDlsMS41My0uNTQsNS40OCw0LjEzdjYuMTloNy42M2w0LjQ5LDYuMjgtLjYzLDEuMzVoLTExLjR2MTEuODVjMCwzLjQ3LS4wNCw2LjEzLS4xMyw3Ljk5LS4wOSwxLjg2LS4yLDMuMjMtLjMxLDQuMTMtLjEyLjktLjE4LDEuNzQtLjE4LDIuNTEsMCwxLjIuNjMsMS43OSwxLjg4LDEuNzksMS4wOCwwLDIuMjQtLjI4LDMuNS0uODUsMS4yNi0uNTcsMi40Mi0xLjI3LDMuNS0yLjExaDEuMjZsNC4yMiw3Yy0uODQsMS4wMi0yLjE1LDEuODgtMy45NSwyLjYtMS44LjcyLTMuNDQsMS4wOC00Ljk0LDEuMDhaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTYyLjkxLDc3Ljg4Yy01LjE1LTEuNjctOC44Ni0zLjEzLTExLjEzLTQuMzUtMi4yNy0xLjIzLTMuNDEtMi4xMS0zLjQxLTIuNjUsMC0uNjYuMS0xLjc5LjMxLTMuNDEuMjEtMS42Mi4zMS00LjEzLjMxLTcuNTR2LTExLjEzYzAtMS4yLjA2LTIuNjIuMTgtNC4yNi4xMi0xLjY0LjMtMy4wNC41NC00LjE3aC0zLjMybC00LjY3LTYuMTkuNjMtMS40NGg4LjQ0Yy4zLDAsLjg1LjQ0LDEuNjYsMS4zLjgxLjg3LDEuNjMsMS44MSwyLjQ3LDIuODMuOTYtMS41NiwyLjI5LTIuNjksMy45OS0zLjQxLDEuNzEtLjcyLDMuNTEtMS4wOCw1LjQzLTEuMDguOTYsMCwxLjY3LjA2LDIuMTUuMThsNC40OSw2LjI4LS43MiwxLjA4Yy00LjE5LS4wNi03LjMuNzUtOS4zMywyLjQyLTIuMDQsMS42OC0zLjA1LDQuNzYtMy4wNSw5LjI1djkuNmMwLDIuOTktLjA4LDUuMzEtLjIyLDYuOTYtLjE1LDEuNjUtLjIyLDIuNzQtLjIyLDMuMjgsMCwuMzYuMTIuNjcuMzYuOTQuMjQuMjcuODIuNTgsMS43NS45NC45My4zNiwyLjQxLjk2LDQuNDQsMS43OWwtMS4wOCwyLjc4WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTIwMi4zMSw3Ni42M2MtMS40NC0uNDgtMi43NS0uOTctMy45NS0xLjQ4LTEuMi0uNTEtMi4zMy0xLjA2LTMuNDEtMS42Ni0uODQuODQtMS44NCwxLjUxLTMuMDEsMi4wMi0xLjE3LjUxLTIuNS43Ni0zLjk5Ljc2LTEuMDIsMC0yLjUtLjMzLTQuNDQtLjk5LTEuOTQtLjY2LTMuOTQtMS41MS01Ljk3LTIuNTYtMi4wNC0xLjA1LTMuNzYtMi4yMS01LjE2LTMuNS0xLjQxLTEuMjktMi4xMS0yLjU2LTIuMTEtMy44MiwwLTEuNTYuMDEtMi45NS4wNC00LjE3LjAzLTEuMjMuMDQtMS45Ni4wNC0yLjIsMC0zLjUzLjkxLTYuMDMsMi43NC03LjUsMS44Mi0xLjQ2LDQuMzgtMi4yLDcuNjctMi4yLDEuNjcsMCwzLjQ3LjEyLDUuMzkuMzYsMS45MS4yNCwzLjQ3LjUxLDQuNjcuODEuMDYtMS42Ny4xLTMuMjguMTMtNC44LjAzLTEuNTMuMDQtMi42OC4wNC0zLjQ2LDAtLjY2LS4xOC0xLjE0LS41NC0xLjQ0LS4zNi0uMy0xLjAyLS40NS0xLjk3LS40NS0yLjMzLDAtNC4zMS4xOC01LjkyLjU0LTEuNjIuMzYtMy4xNC45Ni00LjU4LDEuNzloLTEuNzFsLTUuODMtOC41My43Mi0xLjQ0aDE0Ljk5YzEuMiwwLDIuNTYuNDYsNC4wOCwxLjM5LDEuNTMuOTMsMy4wNCwyLjA4LDQuNTMsMy40NiwxLjUsMS4zOCwyLjcyLDIuNzgsMy42OCw0LjIyLjk2LDEuNDQsMS40NCwyLjY5LDEuNDQsMy43NywwLDEuOTctLjA2LDQuMzEtLjE4LDctLjEyLDIuNjktLjI0LDUuNDMtLjM2LDguMjEtLjEyLDIuNzgtLjE4LDUuMzEtLjE4LDcuNTgsMCwxLjguMywzLjA0LjksMy43My42LjY5LDEuNzMsMS4zNiwzLjQxLDIuMDJsLTEuMTcsMi41MVpNMTc5LjE2LDY1LjQxYzAsMS41LjI3LDIuNDQuODEsMi44My41NC4zOSwxLjIuNTgsMS45Ny41OCwyLjQ1LDAsNC41LS42NCw2LjE1LTEuOTMsMS42NS0xLjI5LDIuNDctMy4zMSwyLjQ3LTYuMDYsMC0uNTQuMDEtMS4yLjA0LTEuOTguMDMtLjc4LjA0LTEuNjQuMDQtMi42LS42Ni0uMTgtMS40Ny0uMy0yLjQyLS4zNi0uOTYtLjA2LTEuODMtLjA5LTIuNi0uMDktMi4xNSwwLTMuNzcuNDgtNC44NSwxLjQ0LTEuMDguOTYtMS42MiwyLjYzLTEuNjIsNS4wM3YzLjE0WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTExLjUyLDkwLjgxYy0xLjU0LDAtMi42OC0xLjE5LTIuNjgtMi42OWgwYzAtMS41LDEuMTItMi43MiwyLjcyLTIuNzIuOTgsMCwxLjU3LjMzLDIuMDYuODFsLS43My44NGMtLjQtLjM3LS44MS0uNTktMS4zNC0uNTktLjg4LDAtMS41MS43My0xLjUxLDEuNjN2LjAyYzAsLjkuNjIsMS42NCwxLjUxLDEuNjQuNiwwLC45Ni0uMjQsMS4zNy0uNjFsLjczLjc0Yy0uNTQuNTctMS4xMy45My0yLjE0LjkzWiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE0LjY0LDkwLjcydi01LjIyaDEuMTV2NS4yMmgtMS4xNVoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xOS40Niw4Ni41NXY0LjE2aC0xLjE1di00LjE2aC0xLjU5di0xLjA2aDQuMzN2MS4wNmgtMS41OVoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yNC41NSw4OC42NHYyLjA4aC0xLjE1di0yLjA2bC0yLjAxLTMuMTZoMS4zNGwxLjI1LDIuMSwxLjI3LTIuMWgxLjMxbC0yLjAxLDMuMTRaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMzIuNzksOTAuNzJ2LTIuMWgtMi4xMnYyLjFoLTEuMTV2LTUuMjJoMS4xNXYyLjA3aDIuMTJ2LTIuMDdoMS4xNXY1LjIyaC0xLjE1WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTM1LjIsOTAuNzJ2LTUuMjJoMy45NHYxLjAyaC0yLjh2MS4wNmgyLjQ2djEuMDJoLTIuNDZ2MS4xaDIuODR2MS4wMmgtMy45OFoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik00NC4wOSw5MC43MmwtLjQ4LTEuMTdoLTIuMjFsLS40OCwxLjE3aC0xLjE3bDIuMjQtNS4yNmgxLjA2bDIuMjQsNS4yNmgtMS4yWk00Mi41MSw4Ni44NGwtLjY5LDEuNjloMS4zOWwtLjY5LTEuNjlaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNDcuNzksODYuNTV2NC4xNmgtMS4xNXYtNC4xNmgtMS41OXYtMS4wNmg0LjMzdjEuMDZoLTEuNTlaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNNTYuMzksOTAuNzJsLS40OC0xLjE3aC0yLjIxbC0uNDgsMS4xN2gtMS4xN2wyLjI0LTUuMjZoMS4wNmwyLjI0LDUuMjZoLTEuMlpNNTQuODEsODYuODRsLS42OSwxLjY5aDEuMzlsLS42OS0xLjY5WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTYwLjUyLDkwLjgxYy0xLjU0LDAtMi42OC0xLjE5LTIuNjgtMi42OWgwYzAtMS41LDEuMTItMi43MiwyLjcyLTIuNzIuOTgsMCwxLjU3LjMzLDIuMDYuODFsLS43My44NGMtLjQtLjM3LS44MS0uNTktMS4zNC0uNTktLjg4LDAtMS41MS43My0xLjUxLDEuNjN2LjAyYzAsLjkuNjIsMS42NCwxLjUxLDEuNjQuNiwwLC45Ni0uMjQsMS4zNy0uNjFsLjczLjc0Yy0uNTQuNTctMS4xMy45My0yLjE0LjkzWiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTY1Ljk1LDg2LjU1djQuMTZoLTEuMTV2LTQuMTZoLTEuNTl2LTEuMDZoNC4zM3YxLjA2aC0xLjU5WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTY4LjQ3LDkwLjcydi01LjIyaDEuMTV2NS4yMmgtMS4xNVoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik03My40Nyw5MC44MWMtMS42MSwwLTIuNzctMS4yLTIuNzctMi42OWgwYzAtMS41LDEuMTctMi43MiwyLjc4LTIuNzJzMi43NywxLjIsMi43NywyLjY5di4wMmMwLDEuNDgtMS4xNywyLjctMi43OCwyLjdaTTc1LjA1LDg4LjExYzAtLjktLjY2LTEuNjQtMS41OC0xLjY0cy0xLjU3LjczLTEuNTcsMS42M3YuMDJjMCwuOS42NiwxLjY0LDEuNTgsMS42NHMxLjU3LS43MywxLjU3LTEuNjNoMFoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik04MC45NCw5MC43MmwtMi41My0zLjMydjMuMzJoLTEuMTN2LTUuMjJoMS4wNmwyLjQ1LDMuMjJ2LTMuMjJoMS4xM3Y1LjIyaC0uOThaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNODUuNDcsOTAuNzJ2LTUuMjJoMS4xNXY1LjIyaC0xLjE1WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTkxLjU5LDkwLjcybC0yLjUzLTMuMzJ2My4zMmgtMS4xM3YtNS4yMmgxLjA2bDIuNDUsMy4yMnYtMy4yMmgxLjEzdjUuMjJoLS45OFoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik05Ni4xOSw4Ni41NXY0LjE2aC0xLjE1di00LjE2aC0xLjU5di0xLjA2aDQuMzN2MS4wNmgtMS41OVoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik05OC42Nyw5MC43MnYtNS4yMmgzLjk0djEuMDJoLTIuOHYxLjA2aDIuNDZ2MS4wMmgtMi40NnYxLjFoMi44NHYxLjAyaC0zLjk4WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTEwMy42Nyw5MC43MnYtNS4yMmgxLjE1djQuMThoMi42djEuMDRoLTMuNzVaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTA4LjI5LDkwLjcydi01LjIyaDEuMTV2NC4xOGgyLjZ2MS4wNGgtMy43NVoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xMTIuOTcsOTAuNzJ2LTUuMjJoMS4xNXY1LjIyaC0xLjE1WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTExNy45NCw5MC44MWMtMS42MywwLTIuNzUtMS4xNC0yLjc1LTIuNjloMGMwLTEuNSwxLjE2LTIuNzIsMi43NC0yLjcyLjk0LDAsMS41MS4yNSwyLjA1LjcybC0uNzIuODdjLS40LS4zMy0uNzYtLjUzLTEuMzctLjUzLS44NCwwLTEuNS43NC0xLjUsMS42M3YuMDJjMCwuOTYuNjYsMS42NiwxLjU4LDEuNjYuNDIsMCwuNzktLjEsMS4wOC0uMzF2LS43NWgtMS4xNnYtLjk5aDIuMjd2Mi4yN2MtLjU0LjQ2LTEuMjguODMtMi4yMy44M1oiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xMjEuMjgsOTAuNzJ2LTUuMjJoMy45NHYxLjAyaC0yLjh2MS4wNmgyLjQ2djEuMDJoLTIuNDZ2MS4xaDIuODR2MS4wMmgtMy45OFoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xMjkuOTUsOTAuNzJsLTIuNTMtMy4zMnYzLjMyaC0xLjEzdi01LjIyaDEuMDZsMi40NSwzLjIydi0zLjIyaDEuMTN2NS4yMmgtLjk4WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTEzNC42Myw5MC44MWMtMS41NCwwLTIuNjgtMS4xOS0yLjY4LTIuNjloMGMwLTEuNSwxLjEyLTIuNzIsMi43Mi0yLjcyLjk4LDAsMS41Ny4zMywyLjA2LjgxbC0uNzMuODRjLS40LS4zNy0uODEtLjU5LTEuMzQtLjU5LS44OCwwLTEuNTEuNzMtMS41MSwxLjYzdi4wMmMwLC45LjYyLDEuNjQsMS41MSwxLjY0LjYsMCwuOTYtLjI0LDEuMzctLjYxbC43My43NGMtLjU0LjU3LTEuMTMuOTMtMi4xNC45M1oiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xMzcuNyw5MC43MnYtNS4yMmgzLjk0djEuMDJoLTIuOHYxLjA2aDIuNDZ2MS4wMmgtMi40NnYxLjFoMi44NHYxLjAyaC0zLjk4WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE0OC44Myw5MC43MmwtLjQ4LTEuMTdoLTIuMjFsLS40OCwxLjE3aC0xLjE3bDIuMjQtNS4yNmgxLjA2bDIuMjQsNS4yNmgtMS4yWk0xNDcuMjUsODYuODRsLS42OSwxLjY5aDEuMzlsLS42OS0xLjY5WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE1NC41LDkwLjcybC0yLjUzLTMuMzJ2My4zMmgtMS4xM3YtNS4yMmgxLjA2bDIuNDUsMy4yMnYtMy4yMmgxLjEzdjUuMjJoLS45OFoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xNTguNzgsOTAuNzJoLTIuMDR2LTUuMjJoMi4wNGMxLjY0LDAsMi43OCwxLjEzLDIuNzgsMi42di4wMmMwLDEuNDctMS4xMywyLjYxLTIuNzgsMi42MVpNMTYwLjM1LDg4LjExYzAtLjkzLS42My0xLjU3LTEuNTctMS41N2gtLjg5djMuMTVoLjg5Yy45NCwwLDEuNTctLjYzLDEuNTctMS41NmgwWiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE2Ny45OSw5MC43MmwtMS4xMi0xLjY3aC0uOXYxLjY3aC0xLjE1di01LjIyaDIuMzljMS4yMywwLDEuOTcuNjUsMS45NywxLjcyaDBjMCwuODYtLjQ2LDEuMzktMS4xMiwxLjYzbDEuMjgsMS44N2gtMS4zNFpNMTY4LjAxLDg3LjI4YzAtLjQ5LS4zNC0uNzUtLjktLjc1aC0xLjE0djEuNWgxLjE2Yy41NiwwLC44OC0uMy44OC0uNzRoMFoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xNzAuMjcsOTAuNzJ2LTUuMjJoMS4xNXY1LjIyaC0xLjE1WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTE3NC41OSw5MC43OWMtLjc5LDAtMS41OS0uMjgtMi4yMi0uODNsLjY4LS44MWMuNDcuMzkuOTYuNjMsMS41Ni42My40NywwLC43NS0uMTkuNzUtLjQ5aDBjMC0uMzEtLjE4LS40Ni0xLjA1LS42OC0xLjA1LS4yNy0xLjczLS41Ni0xLjczLTEuNnYtLjAyYzAtLjk1Ljc2LTEuNTcsMS44My0xLjU3Ljc2LDAsMS40MS4yNCwxLjk0LjY2bC0uNi44N2MtLjQ2LS4zMi0uOTItLjUxLTEuMzYtLjUxcy0uNjcuMi0uNjcuNDZ2LjAyYzAsLjM0LjIyLjQ2LDEuMTMuNjksMS4wNi4yOCwxLjY2LjY2LDEuNjYsMS41N2gwYzAsMS4wNS0uNzksMS42My0xLjkyLDEuNjNaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTgwLjg4LDkwLjcybC0xLjYyLTIuMjItLjYuNjN2MS42aC0xLjE1di01LjIyaDEuMTV2Mi4yOGwyLjEyLTIuMjhoMS4zOWwtMi4xMywyLjIyLDIuMjIsMy4wMWgtMS4zOFoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xODkuMDksOTAuNzJsLS40OC0xLjE3aC0yLjIxbC0uNDgsMS4xN2gtMS4xN2wyLjI0LTUuMjZoMS4wNmwyLjI0LDUuMjZoLTEuMlpNMTg3LjUxLDg2Ljg0bC0uNjksMS42OWgxLjM5bC0uNjktMS42OVoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0xOTIuNzksODYuNTV2NC4xNmgtMS4xNXYtNC4xNmgtMS41OXYtMS4wNmg0LjMzdjEuMDZoLTEuNTlaIi8+PHBhdGggY2xhc3M9ImNscy0xIiBkPSJNMTk1LjI3LDkwLjcydi01LjIyaDEuMTV2NC4xOGgyLjZ2MS4wNGgtMy43NVoiLz48cGF0aCBjbGFzcz0iY2xzLTEiIGQ9Ik0yMDMuNzgsOTAuNzJsLS40OC0xLjE3aC0yLjIxbC0uNDgsMS4xN2gtMS4xN2wyLjI0LTUuMjZoMS4wNmwyLjI0LDUuMjZoLTEuMlpNMjAyLjIsODYuODRsLS42OSwxLjY5aDEuMzlsLS42OS0xLjY5WiIvPjxwYXRoIGNsYXNzPSJjbHMtMSIgZD0iTTIwNy41Nyw5MC43OWMtLjc5LDAtMS41OS0uMjgtMi4yMi0uODNsLjY4LS44MWMuNDcuMzkuOTYuNjMsMS41Ni42My40NywwLC43NS0uMTkuNzUtLjQ5aDBjMC0uMzEtLjE4LS40Ni0xLjA1LS42OC0xLjA1LS4yNy0xLjczLS41Ni0xLjczLTEuNnYtLjAyYzAtLjk1Ljc2LTEuNTcsMS44My0xLjU3Ljc2LDAsMS40MS4yNCwxLjk0LjY2bC0uNi44N2MtLjQ2LS4zMi0uOTItLjUxLTEuMzYtLjUxcy0uNjcuMi0uNjcuNDZ2LjAyYzAsLjM0LjIyLjQ2LDEuMTMuNjksMS4wNi4yOCwxLjY2LjY2LDEuNjYsMS41N2gwYzAsMS4wNS0uNzksMS42My0xLjkyLDEuNjNaIi8+PC9zdmc+';

  var logoImage = ui.Label({
    imageUrl: LOGO_SVG_BASE64,
    style: {
      width: '280px',
      height: '137px',
      margin: '0 auto 12px auto',
      padding: '0px'
    }
  });
  sidePanel.add(logoImage);

  // Title label removed - now part of logo panel above

  // Collaboration label removed for general purpose use
  // Previously: "A collaboration between NRDC India and India Energy and Climate Center, UC Berkeley"

  // ═══════════════════════════════════════════════════════════════════════
  // EMAIL VERIFICATION DIALOG (floating panel over the map)
  // Neutral styling: white background, black text, thin black border.
  // GEE has no modal API; a positioned panel on the map is the equivalent.
  // ═══════════════════════════════════════════════════════════════════════

  emailPanel = ui.Panel({
    style: {
      position: 'top-center',
      margin: '90px 0 0 0',
      width: '340px',
      backgroundColor: 'white',
      border: '1px solid #bbb',
      padding: '16px',
      shown: false  // hidden by default; toggled with style().set('shown', ...)
    }
  });

  emailHeaderLabel = ui.Label('Unlock this city', {
    fontSize: '14px',
    fontWeight: 'bold',
    color: '#000000',
    backgroundColor: 'white',
    margin: '0 0 4px 0'
  });

  emailStatusLabel = ui.Label('Please enter your details to view the selected city. ' +
    'You will receive a 4-digit code to access it.', {
    fontSize: '12px',
    color: '#000000',
    backgroundColor: 'white',
    margin: '0 0 10px 0'
  });

  nameInput = ui.Textbox({
    placeholder: 'Full name',
    style: {
      stretch: 'horizontal',
      margin: '0 0 6px 0'
    }
  });

  orgInput = ui.Textbox({
    placeholder: 'Organization',
    style: {
      stretch: 'horizontal',
      margin: '0 0 6px 0'
    }
  });

  emailInput = ui.Textbox({
    placeholder: 'Email address',
    style: {
      stretch: 'horizontal',
      margin: '0 0 8px 0'
    }
  });

  // OTP instruction: appears directly below the email field after Step 1
  otpInstructionLabel = ui.Label('', {
    fontSize: '12px',
    color: '#333',
    backgroundColor: 'white',
    margin: '10px 0 4px 0',
    shown: false
  });

  emailErrorLabel = ui.Label('', {
    fontSize: '11px',
    color: '#d32f2f',
    backgroundColor: 'white',
    margin: '0 0 8px 0',
    shown: false
  });

  continueButton = ui.Button({
    label: 'Continue',
    style: {
      stretch: 'horizontal',
      width: '100%',
      margin: '0 0 4px 0'
    },
    onClick: function() {
      handleEmailSubmit();
    }
  });

  // Step 2: link to the Apps Script logging page (opens in a new tab).
  // A top-level navigation is the only outbound request a sandboxed GEE app
  // can reliably trigger; the image-beacon approach is blocked by CSP.
  // NOTE: setUrl() in handleEmailSubmit() makes this a hyperlink, and GEE then
  // renders it in its own link colour - the color below has no visible effect.
  // Instructions therefore refer to this by its label text, not by colour.
  verifyLinkLabel = ui.Label('Send code to my email', {
    fontSize: '13px',
    fontWeight: 'bold',
    color: '#1a73e8',
    backgroundColor: '#e8f0fe',
    border: '1px solid #1a73e8',
    padding: '8px',
    textAlign: 'center',
    stretch: 'horizontal',
    margin: '10px 0 8px 0',
    shown: false
  });

  // Step 3: code entry proves the logging page was actually opened
  codeInput = ui.Textbox({
    placeholder: '4-digit code from your email',
    style: {
      stretch: 'horizontal',
      margin: '0 0 8px 0',
      shown: false
    }
  });

  codeErrorLabel = ui.Label('', {
    fontSize: '11px',
    color: '#d32f2f',
    backgroundColor: 'white',
    margin: '0 0 8px 0',
    shown: false
  });

  codeButton = ui.Button({
    label: 'Unlock city',
    style: {
      stretch: 'horizontal',
      width: '100%',
      margin: '0 0 4px 0',
      shown: false
    },
    onClick: function() {
      handleCodeSubmit();
    }
  });

  changeDetailsButton = ui.Button({
    label: 'Change my details',
    style: {
      stretch: 'horizontal',
      width: '100%',
      margin: '4px 0 0 0',
      fontSize: '11px',
      shown: false
    },
    onClick: function() {
      showEmailStage('form');
    }
  });

  var cancelButton = ui.Button({
    label: 'Cancel',
    style: {
      stretch: 'horizontal',
      width: '100%',
      margin: '4px 0 0 0'
    },
    onClick: function() {
      // Dismiss the dialog and return to the last accessible city
      emailPanel.style().set('shown', false);
      showEmailStage('form');
      pendingCity = null;
      var backCity = computationState.currentCity || 'Agra';
      citySelect.setValue(backCity, true);
    }
  });

  var infoLabel = ui.Label('Agra is open to everyone - no sign-in needed.', {
    fontSize: '10px',
    color: '#666666',
    backgroundColor: 'white',
    fontStyle: 'italic',
    margin: '8px 0 0 0'
  });

  emailPanel.add(emailHeaderLabel);
  emailPanel.add(emailStatusLabel);
  emailPanel.add(nameInput);
  emailPanel.add(orgInput);
  emailPanel.add(emailInput);
  emailPanel.add(emailErrorLabel);
  emailPanel.add(continueButton);
  emailPanel.add(otpInstructionLabel);
  emailPanel.add(verifyLinkLabel);
  emailPanel.add(codeInput);
  emailPanel.add(codeErrorLabel);
  emailPanel.add(codeButton);
  emailPanel.add(changeDetailsButton);
  emailPanel.add(cancelButton);
  emailPanel.add(infoLabel);

  // Add the dialog to the MAP (not the sidebar) exactly once, hidden.
  // Visibility controlled by style().set('shown', ...)
  mapPanel.add(emailPanel);

  // ═══════════════════════════════════════════════════════════════════════
  // CITY SELECTOR
  // ═══════════════════════════════════════════════════════════════════════
  citySelect = ui.Select({
    items: ['Agra'].concat(
      Object.keys(cityConfigs)
        .filter(function(c) { return c !== 'Agra'; })
        .sort()
    ),  // Agra (public, default) first; protected cities alphabetical
    placeholder: 'Choose a city...',
    onChange: function(value) {
      // Check access gate BEFORE isRunning guard
      // Email panel display and logging touch no computation state, safe to run mid-computation
      var isPublic = PUBLIC_CITIES.indexOf(value) > -1;
      var needsEmail = !isPublic && !accessState.emailProvided;

      if (needsEmail) {
        // Gate path: show email panel, log denial, return before any computation starts
        cityName = value;
        runAnalysis();
        return;
      }

      // Block city changes during active computation (but allow gate path above)
      if (computationState.isRunning && computationState.currentCity !== value) {
        citySelect.setValue(computationState.currentCity, false);
        return;
      }

      cityName = value;
      computationState.currentCity = value;
      // Clear cache only if switching to different city
      if (computationState.lastCity !== value) {
        computeCache = {};
      }
      runAnalysis();
    },
    style: {
      width: '100%',
      margin: '0 0 8px 0',
      fontSize: '13px',
      color: '#000',
      backgroundColor: '#ffffff'
    }
  });
  sidePanel.add(citySelect);

  currentLayerLabel = ui.Label('CURRENT LAYER: Surface Temperature Hotspots', {
    fontWeight: '500',
    fontSize: '11px',
    color: '#000',
    backgroundColor: '#ffffff',
    padding: '4px 8px',
    margin: '0 0 10px 0',
    border: '1px solid #000000'
  });
  sidePanel.add(currentLayerLabel);

  layerSelect = ui.Select({
    items: [],
    placeholder: 'Select a layer...',
    onChange: function(value) {
      if (value) {
        showLayer(value);
        updateInfo(value);
      }
    },
    style: {
      width: '100%',
      margin: '0 0 16px 0',
      fontSize: '11px',
      color: '#000',
      backgroundColor: '#ffffff'
    }
  });
  sidePanel.add(layerSelect);

  priorityButton = ui.Button({
    label: '▼ Show Priority Wards',
    onClick: function() {
      if (priorityPanel) {
        var isShown = priorityPanel.style().get('shown');
        priorityPanel.style().set('shown', !isShown);
        priorityButton.setLabel(isShown ? '▼ Show Priority Wards' : '▲ Hide Priority Wards');

        if (!isShown) {
          var currentLayer = layerSelect.getValue();
          if (currentLayer) {
            updatePriorityWardDisplay(currentLayer);
          }
        }
      }
    },
    style: {
      width: '100%',
      margin: '0 0 8px 0',
      fontSize: '11px',
      backgroundColor: '#f0f0f0',
      color: '#000'
    }
  });
  sidePanel.add(priorityButton);

  // Export Ward Statistics button
  // NOTE: Commented out - Export.table.toDrive() only works in Code Editor, not published apps
  // Users should run the script in Code Editor to use export functionality
  /*
  var exportButton = ui.Button({
    label: 'Export Ward Data to Drive',
    onClick: function() {
      exportWardStatistics();
    },
    style: {
      width: '100%',
      margin: '0 0 8px 0',
      fontSize: '11px',
      backgroundColor: '#4CAF50',
      color: '#000000'
    }
  });
  sidePanel.add(exportButton);
  */

  // ⚡ Admin-only: queue asset-cache exports for the current city.
  // ADMIN_EXPORT_MODE stays false in the deployed app (Export.* would fail
  // there anyway); flip it in the Code Editor when precomputing a city.
  if (ADMIN_EXPORT_MODE) {
    sidePanel.add(ui.Button({
      label: '⚡ Export city cache assets (Code Editor only)',
      onClick: exportCityCacheAssets,
      style: {
        width: '100%',
        margin: '0 0 8px 0',
        fontSize: '11px',
        backgroundColor: '#FFF3E0',
        color: '#000000'
      }
    }));
    sidePanel.add(ui.Button({
      label: '⚡ Export ALL cities (queues 30 tasks)',
      onClick: exportAllCityCacheAssets,
      style: {
        width: '100%',
        margin: '0 0 8px 0',
        fontSize: '11px',
        backgroundColor: '#FFE0B2',
        color: '#000000'
      }
    }));
  }

  priorityContent = ui.Panel({
    style: {
      padding: '8px',
      backgroundColor: '#ffffff'
    }
  });

  priorityPanel = ui.Panel({
    widgets: [priorityContent],
    style: {
      backgroundColor: '#ffffff',
      border: '1px solid #e0e0e0',
      margin: '0 0 12px 0',
      shown: false
    }
  });
  sidePanel.add(priorityPanel);

  // Create map legend panel (positioned on map at top-left)
  var mapLegendPanel = ui.Panel({
    style: {
      position: 'top-left',
      padding: '12px 16px',
      backgroundColor: 'rgba(255, 255, 255, 0.9)',
      border: '2px solid #000000',
      maxWidth: '300px'
    }
  });

  // Set legendSection to point to the map legend panel content
  legendSection = mapLegendPanel;

  var descSectionResult = createSimpleSection('DESCRIPTION', [
    ui.Label('Select a city to view data', {fontSize: getResponsiveFontSize('content'), color: '#000'})
  ]);
  sidePanel.add(descSectionResult.section);
  descSection = descSectionResult.content;
  var descTitleLabel = descSectionResult.titleLabel;

  ui.root.add(mapPanel);
  ui.root.add(sidePanel);

  // ════════════════════════════════════════════════════════════════════════════
  // FIXED PANEL LAYOUT: Optimized for desktop viewing
  // ════════════════════════════════════════════════════════════════════════════
  sidePanel.style().set({
    width: '340px',
    padding: '16px',
    position: 'top-right',
    maxHeight: '90%'
  });

  // titleLabel styling removed - now part of logoPanel
  citySelect.style().set('fontSize', '13px');
  // cityLabel.style().set('fontSize', '12px');  // cityLabel not needed - using citySelect dropdown instead
  currentLayerLabel.style().set('fontSize', '11px');
  layerSelect.style().set('fontSize', '13px');
  priorityButton.style().set('fontSize', '11px');

  descTitleLabel.style().set('fontSize', '11px');

  descSection.style().set('padding', '12px');

  var instructionPanel = ui.Panel({
    widgets: [
      ui.Label('CHAITRA', {
        fontSize: '18px',
        fontWeight: 'bold',
        margin: '0 0 2px 0',
        color: '#000'
      }),
      ui.Label('City Heat Action InTelligence and Risk Atlas', {
        fontSize: '13px',
        fontWeight: 'normal',
        fontStyle: 'italic',
        margin: '0 0 12px 0',
        color: '#666'
      }),
      ui.Label('1. Select a city from the dropdown menu', {
        fontSize: '12px',
        margin: '0 0 2px 0',
        color: '#000'
      }),
      ui.Label('2. Choose a layer to explore heat patterns', {
        fontSize: '12px',
        margin: '0 0 10px 0',
        color: '#000'
      }),
      ui.Label('Layer rendering uses high-resolution satellite data (10-100m) and may require up to 20 seconds for initial computation.', {
        fontSize: '11px',
        fontStyle: 'italic',
        margin: '0 0 10px 0',
        color: '#666'
      })
    ],
    style: {
      position: 'top-center',
      backgroundColor: '#ffffff',
      width: '550px',
      padding: '20px',
      border: '1px solid #000000',
      margin: '100px 0 0 0'
    }
  });
  mapPanel.add(instructionPanel);

  ui.util.setTimeout(function() {
    try {
      mapPanel.remove(instructionPanel);
    } catch (e) {}
  }, 10000);

  // ════════════════════════════════════════════════════════════════════════════
  // WARD CLICK HANDLER - Shows ward info on click
  // ════════════════════════════════════════════════════════════════════════════

  // Create info panel for ward clicks (initially hidden)
  var wardInfoPanel = ui.Panel({
    style: {
      position: 'bottom-left',
      padding: '8px 12px',
      backgroundColor: '#ffffff',
      border: '1px solid #000000',
      shown: false
    }
  });
  mapPanel.add(wardInfoPanel);

  // Add legend panel to map at top-left
  mapPanel.add(mapLegendPanel);

  // ═══════════════════════════════════════════════════════════════════════════════
  // LEGEND AUTO-UPDATE: handled by syncLegendToMap() (started in
  // INITIALIZATION). The earlier 500 ms watcher here did not skip the
  // always-on 'Ward Boundaries' layer, so it fired a bogus
  // updateInfo('Ward Boundaries') on every first run and then went dead.

  // ═══════════════════════════════════════════════════════════════════════════════

  // Handle map clicks
  mapPanel.onClick(function(coords) {
    // Only proceed if wards are loaded
    if (!wards) {
      return;
    }

    // Create a point from click coordinates
    var clickPoint = ee.Geometry.Point([coords.lon, coords.lat]);

    // Find ward containing the click point
    var clickedWard = wards.filterBounds(clickPoint).first();

    // Get ward properties
    clickedWard.evaluate(function(feature) {
      wardInfoPanel.clear();

      if (!feature) {
        wardInfoPanel.style().set('shown', false);
        return;
      }

      var props = feature.properties;
      var wardNo = props.WARD_NO || props.ward_no || 'N/A';
      var wardName = props.ward_name || props.WARD_NAME || props.NAME || '';

      // ✅ FIX: Normalize Unicode dashes to standard ASCII hyphen (client-side)
      wardName = String(wardName).replace(/[–—−]/g, '-');

      wardInfoPanel.add(ui.Label('Ward: ' + wardNo, {
        fontWeight: 'bold',
        fontSize: '13px',
        color: '#000',
        margin: '0 0 2px 0'
      }));

      if (wardName && wardName !== '') {
        wardInfoPanel.add(ui.Label(wardName, {
          fontSize: '11px',
          color: '#000',
          margin: '0'
        }));
      }

      wardInfoPanel.style().set('shown', true);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🔒 EMAIL ACCESS CONTROL FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validates email format
 * @param {string} email - Email address to validate
 * @returns {boolean} True if valid email format
 */
function isValidEmail(email) {
  if (!email) return false;
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Handles email submission from the access control panel
 * Validates email, stores it in session, logs access, and triggers analysis
 */
/**
 * Deterministic access code derived from the user's email + UTC date,
 * computed identically in the Apps Script. Because both sides compute the
 * same formula, the app verifies with NO return channel - which is what
 * makes verification possible under GEE's CSP (no fetch/XHR allowed).
 * The Apps Script EMAILS the code to the entered address (see
 * CHAITRA_AppsScript_email_OTP.js), so a correct entry implies BOTH that
 * the log row was written AND that the user controls that inbox.
 * NOTE: formula is visible in app source; a technical reader can compute
 * their own code, so this deters casual misuse rather than a determined
 * bypass. True server-random OTP would need a read-back channel GEE lacks.
 * @returns {string} 4-digit code for the current UTC date
 */
function expectedCode(email, daysAgo) {
  var e = String(email || '').trim().toLowerCase();
  var sum = 0;
  for (var i = 0; i < e.length; i++) {
    sum += e.charCodeAt(i) * (i + 1);
  }
  var d = new Date();
  if (daysAgo) d.setUTCDate(d.getUTCDate() - daysAgo);
  return String(((sum + d.getUTCDate() * 73 + 11) % 9000) + 1000);
}

/**
 * Toggle the dialog between its two stages. 'form' shows the three identity
 * fields; 'code' hides them and shows the send-link + code entry, so the
 * panel reads as a sequence instead of a wall of widgets.
 */
function showEmailStage(stage) {
  var form = (stage === 'form');
  nameInput.style().set('shown', form);
  orgInput.style().set('shown', form);
  emailInput.style().set('shown', form);
  continueButton.style().set('shown', form);
  emailStatusLabel.style().set('shown', form);
  emailErrorLabel.style().set('shown', false);

  otpInstructionLabel.style().set('shown', !form);
  verifyLinkLabel.style().set('shown', !form);
  codeInput.style().set('shown', !form);
  codeButton.style().set('shown', !form);
  changeDetailsButton.style().set('shown', !form);
  codeErrorLabel.style().set('shown', false);
}

/**
 * Validate the form, build the send URL, and advance to the code stage.
 * Does NOT grant access - access is granted in handleCodeSubmit after the
 * user has opened the send page and retrieved the emailed code.
 */
function handleEmailSubmit() {
  var email = emailInput.getValue();
  var fullName = String(nameInput.getValue() || '').trim();
  var org = String(orgInput.getValue() || '').trim();

  print('🔐 Email submit clicked:', email);

  if (fullName.length < 2) {
    emailErrorLabel.setValue('Please enter your full name.');
    emailErrorLabel.style().set('shown', true);
    return;
  }
  if (org.length < 2) {
    emailErrorLabel.setValue('Please enter your organization.');
    emailErrorLabel.style().set('shown', true);
    return;
  }
  if (!isValidEmail(email)) {
    emailErrorLabel.setValue('Please enter a valid email address.');
    emailErrorLabel.style().set('shown', true);
    return;
  }

  emailErrorLabel.style().set('shown', false);

  // Store identity provisionally; emailProvided remains false until code check
  accessState.userEmail = email.trim();
  accessState.userName = fullName;
  accessState.userOrg = org;
  accessState.sessionStart = new Date().toISOString();

  // Build the logging URL. Opening it (top-level navigation via targetUrl)
  // is what writes the Sheet row and displays the access code.
  var logUrl = ACCESS_LOG_URL +
    '?timestamp=' + encodeURIComponent(accessState.sessionStart) +
    '&email=' + encodeURIComponent(accessState.userEmail) +
    '&name=' + encodeURIComponent(accessState.userName) +
    '&org=' + encodeURIComponent(accessState.userOrg) +
    '&city=' + encodeURIComponent(pendingCity || cityName) +
    '&action=email_verified' +
    '&userAgent=' + encodeURIComponent('GEE_App');

  verifyLinkLabel.setUrl(logUrl);

  // Collapse the form; show only what the user needs next. The instruction
  // names their own email address so the next click is self-explanatory.
  otpInstructionLabel.setValue('Click below to email a 4-digit code to ' +
                               accessState.userEmail + ', then enter it here. ' +
                               '(Check spam if it does not appear.)');
  showEmailStage('code');
  print('✅ Email valid. Awaiting link click + code entry.');
}

/**
 * Step 3: check the code from the logging page; on match, unlock the
 * session and run the analysis.
 */
function handleCodeSubmit() {
  var entered = String(codeInput.getValue() || '').trim();

  // Accept today's code and yesterday's: the code rotates at UTC midnight
  // (05:30 IST), and a code emailed just before rotation must still work.
  var codeOk = (entered === expectedCode(accessState.userEmail)) ||
               (entered === expectedCode(accessState.userEmail, 1));

  if (!codeOk) {
    codeErrorLabel.setValue("That code didn't match. Check the latest email we sent " +
                            "(spam too), or click 'Send code to my email' to resend.");
    codeErrorLabel.style().set('shown', true);
    return;
  }

  // Code correct => the logging page was opened => the access row exists
  accessState.emailProvided = true;
  computationState.emailVerified = true;
  computationState.verifiedEmail = accessState.userEmail;

  // Hide the panel and reset it to the form stage for any future use
  emailPanel.style().set('shown', false);
  showEmailStage('form');

  // Now (and only now) switch the global city to the one that was requested
  if (pendingCity) {
    cityName = pendingCity;
    pendingCity = null;
  }

  print('✅ Code verified for', accessState.userEmail, '- unlocking', cityName);
  runAnalysis();
}

/**
 * Logs access attempts to Google Sheets and console
 * @param {string} email - User email address
 * @param {string} city - City being accessed
 * @param {string} action - Type of access (public_access, email_provided, analysis_access)
 */
function logAccessToSheets(email, city, action) {
  var timestamp = new Date().toISOString();
  var userAgent = (typeof navigator !== 'undefined' && navigator.userAgent) ?
                  navigator.userAgent : 'GEE Code Editor';

  // Always log to console for debugging
  print('📝 ═══════════════════════════════════════════════════════');
  print('📝 ACCESS LOG:');
  print('📝   Time:', timestamp);
  print('📝   Email:', email);
  print('📝   City:', city);
  print('📝   Action:', action);
  print('📝   User Agent:', userAgent);
  print('📝 ═══════════════════════════════════════════════════════');

  // NOTE (2026-08): the ui.Label imageUrl beacon does NOT deliver requests
  // from the Code Editor / published Apps (blocked client-side by the page's
  // Content-Security-Policy before any network request is made; verified
  // empirically: direct browser requests to the same URL succeed, beacon
  // requests never arrive). Sheet logging therefore happens exclusively via
  // the Step 2 click-through link in handleEmailSubmit(), which is a
  // top-level navigation and cannot be blocked by CSP.
  // This function now records console diagnostics only; public_access and
  // access_denied events are console-visible but not written to the Sheet.
}

// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────────
// 11. INITIALIZATION

setupUI();

// Start the active legend watcher (see syncLegendToMap): keeps the legend and
// description in step with the map's own layer-toggle widget, which fires no
// callback of its own.
syncLegendToMap();

// Set default city to AGRA (public city - no email required) and auto-run the analysis
cityName = 'Agra';
citySelect.setValue('Agra', true);  // true triggers onChange and runs analysis automatically
