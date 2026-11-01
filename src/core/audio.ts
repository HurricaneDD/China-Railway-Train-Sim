export class HornAudio {
  private context?: AudioContext;
  private gain?: GainNode;
  private oscillators: OscillatorNode[] = [];
  enabled = true;

  async start(): Promise<void> {
    if (!this.enabled || this.oscillators.length) return;
    this.context ??= new AudioContext();
    await this.context.resume();
    this.gain = this.context.createGain();
    this.gain.gain.setValueAtTime(0.0001, this.context.currentTime);
    this.gain.gain.exponentialRampToValueAtTime(0.16, this.context.currentTime + 0.06);
    this.gain.connect(this.context.destination);
    [196, 247, 294].forEach((frequency, index) => {
      const oscillator = this.context!.createOscillator();
      oscillator.type = index === 0 ? 'sawtooth' : 'square';
      oscillator.frequency.value = frequency;
      oscillator.connect(this.gain!);
      oscillator.start();
      this.oscillators.push(oscillator);
    });
  }

  stop(): void {
    if (!this.context || !this.oscillators.length) return;
    const now = this.context.currentTime;
    this.gain?.gain.cancelScheduledValues(now);
    this.gain?.gain.setTargetAtTime(0.0001, now, 0.05);
    this.oscillators.forEach((oscillator) => oscillator.stop(now + 0.25));
    this.oscillators = [];
  }
}
