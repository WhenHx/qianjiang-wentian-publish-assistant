function nowIso() { return new Date().toISOString(); }
function addMs(ms, from = Date.now()) { return new Date(from + ms).toISOString(); }
function isExpired(iso) { return Date.parse(iso) <= Date.now(); }
module.exports = { nowIso, addMs, isExpired };