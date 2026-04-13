-- Spots table
CREATE TABLE IF NOT EXISTS spots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  webcams TEXT DEFAULT '[]',  -- JSON array
  weather_station TEXT DEFAULT NULL,  -- WeatherLink URL token
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- User preferences table  
CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Default preferences
INSERT OR IGNORE INTO preferences (key, value) VALUES ('default_days', '7');
INSERT OR IGNORE INTO preferences (key, value) VALUES ('default_offset', '0');
