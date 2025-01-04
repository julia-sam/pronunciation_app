from flask import Flask, send_from_directory, request, jsonify, send_file
import os
import parselmouth
import tempfile
from pathlib import Path
from openai import OpenAI
import logging
import torch
import torchaudio
import torchaudio.functional as F
from torchaudio.pipelines import MMS_FA
import subprocess
import torchaudio.transforms as T
import soundfile as sf  

app = Flask(__name__, static_folder="/app/build", static_url_path='')

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    handlers=[
        logging.StreamHandler()
    ]
)

device = torch.device("cpu")
bundle = MMS_FA
model = bundle.get_model(with_star=False).to(device)
DICT_NO_STAR = bundle.get_dict(star=None)
LABELS_NO_STAR = bundle.get_labels(star=None)

@app.route('/api/analyze_pitch', methods=['POST'])
def analyze_pitch():
    if 'audio' not in request.files:
        return jsonify({'error': 'No audio file provided'}), 400
    audio_file = request.files['audio']
    
    # Save the uploaded audio to a temporary file
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as temp_wav:
        audio_file.save(temp_wav.name)
        temp_wav_path = temp_wav.name

    try:
        # Process the audio file using Parselmouth
        sound = parselmouth.Sound(temp_wav_path)
        pitch = sound.to_pitch()
        pitch_values = pitch.selected_array['frequency']
        time_stamps = pitch.xs()

        # Format the result as a list of time-frequency pairs
        result = [
            {'time': time, 'frequency': freq}
            for time, freq in zip(time_stamps, pitch_values)
            if freq > 0  # Only include voiced frequencies
        ]

        return jsonify(result)
    except Exception as e:
        logging.error(f"Error in analyze_pitch: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        # Clean up the temporary file
        if os.path.exists(temp_wav_path):
            os.remove(temp_wav_path)

@app.route('/api/text_to_speech', methods=['POST'])
def text_to_speech():
    # Parse the incoming JSON data
    data = request.get_json()
    text = data.get('text')
    api_key = data.get('api_key')

    # Validate the inputs
    if not text:
        return jsonify({'error': 'No text provided'}), 400
    if not api_key:
        return jsonify({'error': 'No API key provided'}), 400

    try:
        # Initialize OpenAI client with the provided API key
        client = OpenAI(api_key=api_key)

        # Create a temporary file for the speech output
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as temp_audio:
            speech_file_path = Path(temp_audio.name)

        # Generate speech 
        response = client.audio.speech.create(
            model="tts-1",  
            voice="alloy",  
            input=text     
        )

        # Stream the audio content into the temporary file
        response.stream_to_file(speech_file_path)

        # Return the audio file to the client
        return send_file(
            speech_file_path,
            as_attachment=True,
            download_name="speech.mp3",
            mimetype="audio/mpeg"
        )

    except Exception as e:
        logging.error(f"Error in text-to-speech generation: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        # Clean up the temporary audio file
        if os.path.exists(speech_file_path):
            os.remove(speech_file_path)

def convert_to_pcm_wav(input_path, output_path):
    """
    Converts an input audio file to PCM WAV format with a sample rate of 16000 Hz.
    """
    try:
        command = [
            "ffmpeg",
            "-i", input_path,
            "-ar", "16000",      # Resample to 16kHz
            "-ac", "1",          # Convert to mono
            "-c:a", "pcm_s16le", # PCM 16-bit encoding
            output_path,
            "-y"                 # Overwrite output file
        ]
        logging.info(f"Converting {input_path} to {output_path} with command: {' '.join(command)}")
        subprocess.run(command, check=True)
        logging.info(f"Conversion successful: {output_path}")
    except subprocess.CalledProcessError as e:
        logging.error(f"ffmpeg conversion failed: {e}")
        raise RuntimeError(f"ffmpeg conversion failed: {e}")

def inspect_audio_file(wav_path):
    """
    Inspects and logs details about the audio file using soundfile.
    """
    try:
        with sf.SoundFile(wav_path) as f:
            duration = len(f) / f.samplerate
            logging.info(f"Audio File: {wav_path}")
            logging.info(f"Sample Rate: {f.samplerate}")
            logging.info(f"Channels: {f.channels}")
            logging.info(f"Duration (seconds): {duration:.2f}")
    except Exception as e:
        logging.error(f"Failed to inspect audio file: {e}")

def forced_align_waveform(wav_path: str, transcript: str):
    """
    Run forced alignment on a single WAV file with the given transcript.
    """
    converted_wav_path = None  # Initialize variable for cleanup
    try:
        # Convert to PCM WAV format
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_converted:
            converted_wav_path = tmp_converted.name
        convert_to_pcm_wav(wav_path, converted_wav_path)
        inspect_audio_file(converted_wav_path)  # Debug the converted file format

        # Attempt to load the audio file using soundfile
        data, sr = sf.read(converted_wav_path)
        logging.info(f"Loaded waveform shape: {data.shape}, sample rate: {sr}")

        # Convert to torch tensor and move to CPU
        waveform = torch.from_numpy(data).float().unsqueeze(0).to(device)  # Add channel dimension and move to device

        # Resample if the sample rate is not 16000 Hz
        if sr != bundle.sample_rate:  
            resampler = T.Resample(orig_freq=sr, new_freq=bundle.sample_rate)
            waveform = resampler(waveform)
            sr = bundle.sample_rate
            logging.info(f"Resampled waveform to sample rate: {sr}")

        # Generate emissions from the model
        with torch.no_grad():
            emissions, _ = model(waveform)

        # Convert transcript to tokens
        tokens = [DICT_NO_STAR[char] for word in transcript.lower().split() for char in word if char in DICT_NO_STAR]

        if not tokens:
            raise ValueError("No valid tokens found in transcript.")

        # Forced alignment
        targets = torch.tensor([tokens], dtype=torch.int32, device=device)
        alignment, score = F.forced_align(emissions, targets, blank=0)

        # Merge repeated tokens
        alignment, score = alignment[0], score[0]
        token_spans = F.merge_tokens(alignment, score.exp())

        # Format alignment results
        alignment_list = [
            {
                "token": LABELS_NO_STAR[span.token],
                "start_frame": span.start,
                "end_frame": span.end,
                "score": float(span.score),
            }
            for span in token_spans
        ]

        return alignment_list

    except Exception as e:
        logging.error(f"Failed during forced alignment: {e}")
        raise RuntimeError(f"Failed during forced alignment: {e}")
    finally:
        # Clean up the converted temporary file
        if converted_wav_path and os.path.exists(converted_wav_path):
            os.remove(converted_wav_path)


MAX_AUDIO_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

@app.route("/api/forced_alignment", methods=["POST"])
def forced_alignment_endpoint():
    tmp_wav_path = None  # Initialize variable for cleanup
    try:
        # Debug input
        logging.info(f"Request files: {request.files}")
        logging.info(f"Request form: {request.form}")

        if 'audio' not in request.files:
            return jsonify({'error': 'No audio file provided'}), 400
        if 'transcript' not in request.form:
            return jsonify({'error': 'No transcript text provided'}), 400

        transcript = request.form['transcript']
        audio_file = request.files['audio']

        # Check file size
        audio_file.seek(0, os.SEEK_END)
        file_size = audio_file.tell()
        audio_file.seek(0)  # Reset file pointer

        if file_size > MAX_AUDIO_FILE_SIZE:
            return jsonify({'error': 'Audio file too large'}), 400

        # Save audio temporarily
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
            audio_file.save(tmp.name)
            tmp_wav_path = tmp.name

        # Debug: Validate audio and transcript
        logging.info(f"Transcript: {transcript}")
        logging.info(f"Temp WAV path: {tmp_wav_path}")

        # Perform forced alignment
        alignment_data = forced_align_waveform(tmp_wav_path, transcript)
        logging.info(f"Alignment result: {alignment_data}")

        return jsonify(alignment_data), 200

    except Exception as e:
        logging.error(f"Error in forced_alignment_endpoint: {e}")
        import traceback
        traceback.print_exc()  # Print full error traceback to the terminal
        return jsonify({'error': f'Internal server error: {str(e)}'}), 500
    finally:
        # Clean up the temporary WAV file
        if tmp_wav_path and os.path.exists(tmp_wav_path):
            os.remove(tmp_wav_path)


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_react_app(path):
    if path != "" and os.path.exists(os.path.join(app.static_folder, path)):
        return send_from_directory(app.static_folder, path)
    return send_from_directory(app.static_folder, "index.html")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
