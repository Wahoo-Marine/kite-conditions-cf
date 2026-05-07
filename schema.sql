-- Spots table
CREATE TABLE IF NOT EXISTS spots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  webcams TEXT DEFAULT '[]',  -- JSON array
  short_slug TEXT DEFAULT NULL, -- optional short public path, e.g. "turks"
  weather_station TEXT DEFAULT NULL,  -- WeatherLink URL token
  sort_order INTEGER DEFAULT 0,
  user_id TEXT DEFAULT NULL,  -- NULL = default spot (visible to all); email = personal spot
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_spots_user_id ON spots(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_spots_short_slug ON spots(short_slug) WHERE short_slug IS NOT NULL;

-- User preferences table  
CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Default preferences
INSERT OR IGNORE INTO preferences (key, value) VALUES ('default_days', '7');
INSERT OR IGNORE INTO preferences (key, value) VALUES ('default_offset', '0');
