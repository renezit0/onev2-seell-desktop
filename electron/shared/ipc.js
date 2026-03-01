const CHANNELS = Object.freeze({
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_TOGGLE_MAXIMIZE: 'window:toggle-maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  APP_GET_VERSION: 'app:get-version',
  APP_CHECK_UPDATES: 'app:check-updates',
  CONFIG_GET: 'config:get',
  CONFIG_SET: 'config:set',
  UPDATE_STATUS: 'update:status',
  WINDOW_STATE: 'window:state'
});

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function validateConfigSet(payload) {
  if (!isPlainObject(payload)) return false;
  if (typeof payload.key !== 'string' || payload.key.length === 0) return false;
  return true;
}

module.exports = {
  CHANNELS,
  validateConfigSet
};
