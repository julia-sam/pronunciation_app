# [START cloudrun_pronunciationapp_dockerfile]

# --------------------------------
# Stage 1: Build the React frontend
# --------------------------------
    FROM node:19 AS build-frontend
    WORKDIR /usr/src/app
    
    # Copy the frontend package files and install dependencies
    COPY frontend/package*.json ./
    RUN npm install --omit=dev
    
    # Copy the rest of the frontend code and build
    COPY frontend/ ./
    RUN npm run build
    
    # --------------------------------
    # Stage 2: Create the Python (Flask) container
    # --------------------------------
    FROM python:3.11-slim
    
    # Let Python log immediately
    ENV PYTHONUNBUFFERED=True
    
    # Install system dependencies needed to build native extensions (e.g., praat-parselmouth)
    RUN apt-get update && apt-get install -y \
        ffmpeg \
        build-essential \
        cmake \
        ninja-build \
        && rm -rf /var/lib/apt/lists/*
    
    # Set up work directory
    ENV APP_HOME=/app
    WORKDIR $APP_HOME
    
    # Copy requirements and install Python dependencies
    COPY requirements.txt .
    RUN pip install --no-cache-dir -r requirements.txt
    
    # Copy backend code
    COPY backend/ /app/backend
    
    # Copy the React build artifacts from the first stage
    COPY --from=build-frontend /usr/src/app/build /app/build
    
    # Expose port 8080 (Cloud Run default)
    EXPOSE 8080
    
    # Use Gunicorn to serve the Flask app
    CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "8", "--timeout", "0", "backend.app:app"]
    
    # [END cloudrun_pronunciationapp_dockerfile]
    