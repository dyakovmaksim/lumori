"""One short local transcription. No network requests at inference time."""
import json
import sys
import numpy as np
from faster_whisper import WhisperModel
from faster_whisper.audio import decode_audio

model_path, audio_path, language = sys.argv[1:4]
audio = decode_audio(audio_path, sampling_rate=16000)
if len(audio) > 125 * 16000:
    raise ValueError('Recording exceeds 125 seconds')
if len(audio) < 1600:
    raise ValueError('Recording is too short')
# Avoid hallucinating text on digital silence; VAD handles pauses in speech.
if float(np.max(np.abs(audio))) < 0.0001:
    print(json.dumps({'text': ''}))
    sys.exit(0)
model = WhisperModel(model_path, device='cpu', compute_type='int8', cpu_threads=1, num_workers=1, local_files_only=True)
segments, info = model.transcribe(audio, language=None if language == 'auto' else language, beam_size=1, vad_filter=True, condition_on_previous_text=False)
print(json.dumps({'text': ' '.join(segment.text.strip() for segment in segments).strip(), 'language': info.language}, ensure_ascii=False))
