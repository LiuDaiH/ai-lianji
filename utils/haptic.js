// utils/haptic.js —— 触感反馈（震动）
//
// 为什么用震动而不是音效：
//   ① 震动**不占包体、不需要音频文件、不需要联网** —— 零成本
//   ② **不会干扰记忆**（带歌词的音乐会显著干扰回忆，白噪音也有争议）
//   ③ 小程序原生支持（wx.vibrateShort），而且用户手机静音时仍然有效
//
// 所以答题反馈优先用震动，效果不输音效，还更"干净"。

let enabled = true;

function readSetting() {
  try {
    const v = wx.getStorageSync('sc_haptic');
    enabled = v === '' || v === undefined || v === null ? true : !!v;
  } catch (e) { enabled = true; }
  return enabled;
}

function setEnabled(v) {
  enabled = !!v;
  try { wx.setStorageSync('sc_haptic', enabled ? 1 : 0); } catch (e) { /* ignore */ }
}

/** 轻震：点击、选中 */
function tap() {
  if (!enabled) return;
  try { wx.vibrateShort({ type: 'light' }); } catch (e) { /* 部分设备不支持 */ }
}

/** 中震：答对 */
function right() {
  if (!enabled) return;
  try { wx.vibrateShort({ type: 'medium' }); } catch (e) { /* ignore */ }
}

/** 重震：答错 */
function wrong() {
  if (!enabled) return;
  try { wx.vibrateShort({ type: 'heavy' }); } catch (e) { /* ignore */ }
}

/** 完成一轮：连震两下 */
function done() {
  if (!enabled) return;
  try {
    wx.vibrateShort({ type: 'medium' });
    setTimeout(() => { try { wx.vibrateShort({ type: 'medium' }); } catch (e) { /* ignore */ } }, 130);
  } catch (e) { /* ignore */ }
}

module.exports = { readSetting, setEnabled, isEnabled: () => enabled, tap, right, wrong, done };
