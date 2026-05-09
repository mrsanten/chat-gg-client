let audio: HTMLAudioElement | null = null;

export function playNotify(): void {
  try {
    if (!audio) {
      audio = new Audio("/notify.mp3");
      audio.volume = 0.6;
      audio.preload = "auto";
    }
    audio.currentTime = 0;
    void audio.play().catch(() => {});
  } catch {
    /* no-op: plik może nie istnieć albo browser zablokował autoplay */
  }
}
