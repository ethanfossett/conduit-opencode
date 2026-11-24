class DuplexCapture extends AudioWorkletProcessor {
	frame = new ArrayBuffer(1920 * 4);
	view = new DataView(this.frame);
	written = 0;

	process(inputs) {
		const channel = inputs[0]?.[0];
		if (!channel) return true;
		for (const sample of channel) {
			this.view.setFloat32(
				this.written,
				Math.max(-1, Math.min(1, sample)),
				true,
			);
			this.written += 4;
			if (this.written === this.frame.byteLength) {
				this.port.postMessage(this.frame, [this.frame]);
				this.frame = new ArrayBuffer(1920 * 4);
				this.view = new DataView(this.frame);
				this.written = 0;
			}
		}
		return true;
	}
}
registerProcessor("conduit-duplex-capture", DuplexCapture);
