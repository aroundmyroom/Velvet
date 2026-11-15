# Audio Output Device Selector

Velvet lets you choose which speaker or audio device your browser routes playback to — without changing the Windows/macOS default device.

The selector lives in **Audio Settings → Audio Output Device**. In browsers that do not support it, the section is hidden.

---

## Browser support

| Browser | Supported |
|---------|-----------|
| Chrome 110+ | ✅ |
| Edge 110+ | ✅ |
| Firefox | ❌ (no `AudioContext.setSinkId`) |
| Safari | ❌ |

---

## First-time setup — granting device permission

Browsers require microphone permission before they will reveal individual audio device names. Velvet never uses the microphone — it just needs the permission to list devices.

If the dropdown shows only **Default**, click **Allow devices**:

1. The browser shows a microphone permission dialog
2. Click **Allow**
3. The microphone stream is immediately released — nothing is recorded
4. The dropdown populates with all your audio outputs

This permission is remembered per browser, per site. You only need to do it once.

In **Chrome**, you can also grant it manually:
- Click the lock icon in the address bar → **Microphone** → **Allow**

In **Edge**, the microphone entry only appears in the lock icon *after* the site has requested it — use the **Allow devices** button instead.

---

## Switching devices

Select any device from the dropdown. The switch is instantaneous — playback continues on the new device without interruption.

The selected device is stored per user in `localStorage` (`ms2_output_device_<username>`) and restored automatically on the next page load, including across browser sessions. Choosing **Default** removes the key.

---

## Technical notes

- Velvet's player uses the **Web Audio API** (`AudioContext`) for EQ, ReplayGain, and VU meters. Because `audioEl` is connected to a `MediaElementSourceNode`, audio is routed through the `AudioContext` — `HTMLMediaElement.setSinkId()` has no effect. The correct API is `AudioContext.setSinkId()`.
- The stored device preference is applied when `ensureAudio()` builds the audio graph (first play), so the correct output is used from the very first track even if the page was loaded with no audio playing. The crossfade element's own `AudioContext` gets the same device.
- The `devicechange` event is monitored: if the stored device disconnects, Velvet clears the stored choice and falls back to the browser default; if it is still present, the device is applied again.
