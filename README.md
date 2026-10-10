<p align="center">
  <img src="icons/icon-128.png" width="128" height="128" alt="YouTube Çeviri logo">
</p>

<p align="center">
  <a href="https://github.com/Blizzelf/youtube-gemini-turkish-subtitles/releases/latest"><img src="https://img.shields.io/github/v/release/Blizzelf/youtube-gemini-turkish-subtitles" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Blizzelf/youtube-gemini-turkish-subtitles" alt="License: MIT"></a>
</p>

# YouTube Çeviri

A Chrome / Edge extension (Manifest V3) that translates YouTube captions into Turkish with Google Gemini and shows them as subtitles on the video.

> [Türkçe açıklama aşağıda.](#türkçe)

## Features

- **Original captions:** Reads the video's own caption track in its original language: manual captions when available, otherwise the auto-generated ones. Handles AI-dubbed videos that have one auto-generated track per audio language.
- **Sentence-aware segmentation:** YouTube's auto-generated captions break lines by screen width, often mid-sentence. The extension regroups words into sentences using word-level timings, so the translation does not drift into the neighboring line.
- **Gemini translation:** Translates in chunks of up to 40 lines with `gemini-2.5-flash` by default, or `gemini-3.8-flash` for better translations, chosen in the popup; the first chunk at the playback position has only 10 lines, so the first subtitles appear within a few seconds. The same happens after seeking to an untranslated part. The model is told to keep the `start` / `duration` structure, and the code checks every response. Timestamps always come from the original captions; only the text is taken from the model.
- **Fast but rate-limit friendly:** Up to 3 chunks are translated at once, with request starts 0.5 s apart. After the first `429` (for example on the free tier) the queue drops to one request at a time, 2.5 s apart, until the browser is closed. On `429` the queue pauses and retries with exponential backoff (honoring `RetryInfo`). A used-up daily quota is reported instead of retried.
- **Progressive display:** Each chunk appears on screen as soon as it is translated, starting at the current playback position. Seeking moves the new position to the front of the queue.
- **Cache:** Translations are stored in `chrome.storage.local` by video ID. Reopening a video loads instantly without calling the API, even after switching models. Interrupted translations resume where they stopped. The cache is limited to 8 MB and removes the least recently used entries first.
- **Export / import:** Move your translations between browsers (for example Chrome to Edge) as a JSON file.
- **On demand:** Nothing is translated until you turn on **Türkçe altyazı** in the menu of the extension's logo button, so the API quota goes only to the videos you choose. Videos translated before load on their own. An option translates every video automatically instead.
- **Player menu:** The extension's logo button at the right end of the player's control bar opens a menu like YouTube's settings menu: subtitles on/off with progress and errors, subtitle mode (Turkish only, or dual with the original line), model, re-translating the video, auto-translate, and the settings page.
- **Subtitle style:** Font size, color, font and bold for the translation and the original line separately, plus background opacity and blur, outline style, and which line is on top. In dual mode the word being spoken in the original line can be highlighted: exactly with auto-generated captions (word timings), estimated from word lengths with manual ones. Only system fonts are used, so nothing is downloaded.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions` (or `edge://extensions` in Edge).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the project folder.
5. Get a Gemini API key from [Google AI Studio](https://aistudio.google.com/app/apikey).
6. Click the extension icon and save your key in the popup.

Requires Chrome / Edge 111 or newer.

## Usage

Open a YouTube video that has captions, click the extension's logo button at the right end of the control bar and turn on **Türkçe altyazı**. The button pulses while the translation is prepared, and Turkish subtitles appear as chunks finish. Use the same switch to hide or show them; while they are on, YouTube's own captions are hidden. If something fails before any subtitle appears (for example a missing API key), turn the switch on again to retry. **Altyazı ayarları** in the menu changes how the subtitles look.

Videos you translated before show their subtitles without a click. To translate one again with the other model, open it and choose **Bu videoyu yeniden çevir** in the menu or the popup. To translate every video as soon as it opens, turn on **Videoları otomatik çevir** in the popup.

The popup also shows how many videos are cached. You can clear the cache or export and import it there.

## How it works

| File | Role |
|---|---|
| `page-bridge.js` | Runs in the page's main world. Reads the player's caption tracks and captures the player's own caption request, which carries the PO token YouTube now requires. Triggers that request when needed and restores the user's caption setting. |
| `content.js` | Picks the original-language track, downloads it as `json3`, sends it for translation and receives the result chunk by chunk. Follows YouTube's single-page navigation. |
| `segmenter.js` | Regroups auto-generated captions into sentences and splits long ones at natural points. |
| `background.js` | Service worker. Owns the API key, the request queue, retries, and the cache. |
| `overlay.js`, `overlay.css` | Draws the subtitles over the player (one or two lines, with the chosen style) and the logo button. |
| `menu.js` | The logo button's menu and the subtitle style settings. |
| `icons/` | Extension icons (toolbar, extensions page, popup). The player button embeds the same logo in `overlay.css`. |
| `popup.html`, `popup.js` | API key, model, re-translating the open video, auto-translate option, cache stats, clear, export and import. |

## Privacy

- Your API key is stored only in your browser (`chrome.storage.local`). It is not in any project file and is never synced.
- Only the background service worker reads the key. It is sent only to `generativelanguage.googleapis.com`, in the `x-goog-api-key` header.
- The caption text and the video title are sent to the Gemini API for translation. Nothing else leaves your browser.
- Export files contain translations only, never the API key.

## Limitations

- The target language is fixed to Turkish.
- The extension relies on undocumented behavior of YouTube's web player, such as the PO token on caption requests. YouTube can change this at any time and break caption download.
- The Gemini free tier has tight rate limits. Long videos can take a few minutes, and the daily quota can run out.

## Development

The tests need Node.js 18 or newer and no dependencies. The chrome APIs and Gemini are mocked, so no real requests are made.

```bash
npm test
```

Code comments, log messages and tests are in English. Text shown to users (popup, overlay, menu, error messages) is in Turkish.

## License

[MIT](LICENSE)

This project is not affiliated with, endorsed by or sponsored by YouTube or Google.

---

## Türkçe

YouTube altyazılarını Google Gemini ile Türkçeye çevirip videonun üstünde altyazı olarak gösteren bir Chrome / Edge eklentisi (Manifest V3).

**Öne çıkanlar:**
- Yalnızca istediğiniz videoyu çevirir: oynatıcıdaki logo butonu YouTube'un ayar menüsüne benzeyen bir menü açar, **Türkçe altyazı**'yı açınca çeviri başlar. Daha önce çevrilen videolar kendiliğinden yüklenir. İsterseniz her videoyu otomatik çevirmeyi açabilirsiniz.
- Menüden altyazı modu (yalnız Türkçe ya da orijinalle birlikte çift dil) ve altyazı stili (yazı boyutu, renk, yazı tipi, kalınlık, arka plan, kontur) ayarlanır. Çift dil modunda orijinal satırda o an söylenen kelime vurgulanabilir.
- Videonun orijinal dildeki altyazısını alır. Otomatik altyazıyı, çeviride anlam kaymasın diye cümlelere göre yeniden böler.
- Varsayılan olarak `gemini-2.5-flash` ile parça parça çevirir; daha iyi çeviri için popup'tan `gemini-3.8-flash` seçilebilir. Önceden çevrilmiş bir video popup'taki **Bu videoyu yeniden çevir** butonuyla seçili modelle baştan çevrilebilir. Zaman damgaları her zaman orijinalden alınır.
- Hız sınırına (429) takılınca bekleyip tekrar dener. Çevrilen parçalar hemen ekranda görünür.
- Çeviriler tarayıcıda saklanır. Aynı video tekrar açılınca API'ye gitmeden anında yüklenir.
- Çevirileri tarayıcılar arasında dosya ile taşıyabilirsiniz (dışa / içe aktar).

**Kurulum:**
1. Depoyu indirin.
2. `chrome://extensions` (Edge'de `edge://extensions`) sayfasını açın ve **Geliştirici modu**'nu açın.
3. **Paketlenmemiş öğe yükle** ile proje klasörünü seçin.
4. [Google AI Studio](https://aistudio.google.com/app/apikey)'dan bir Gemini API anahtarı alın ve eklenti popup'ına kaydedin.

API anahtarınız yalnızca tarayıcınızda saklanır ve yalnızca Gemini API'sine gönderilir.
