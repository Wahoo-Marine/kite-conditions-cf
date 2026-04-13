-- Seed data from existing spots.json
INSERT OR REPLACE INTO spots (id, name, lat, lon, webcams, sort_order) VALUES
  ('1fed4054', 'Cape Hatteras, NC', 35.2225, -75.635, '[]', 0),
  ('9e0775a8', 'Outer Banks - Rodanthe, NC', 35.5935, -75.4638, '[]', 1),
  ('fc6a762e', 'Key West, FL', 24.5551, -81.78, '[{"oid":"EMB_CSDO000005A2","label":"Harborside Marina"},{"oid":"EMB_CUVK000007A5","label":"Mallory Square"},{"oid":"EMB_LKOU000004E4","label":"Sunset Pier"},{"oid":"EMB_RKNO000004F8","label":"Sunset Cam"}]', 2),
  ('84f34fe3', 'Grand Cayman, Cayman Islands', 19.3133, -81.2546, '[]', 3),
  ('5eecbbad', 'Providenciales, Turks & Caicos', 21.7735, -72.2686, '[{"twitch":"villaesencia","label":"Villa Esencia Beach Cam"}]', 4),
  ('c0cf3b3d', 'Dauphin Island, AL', 30.2552, -88.11, '[]', 5),
  ('9466c8c0', 'South Padre Island, TX', 26.1037, -97.1647, '[]', 6);
