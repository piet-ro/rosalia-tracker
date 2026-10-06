import json
import sys
import os
from datetime import datetime, timedelta
import spotipy
from spotipy.oauth2 import SpotifyOAuth

# Configuration & Files
LAST_PLAYED_FILE = "last_played.json"
HISTORY_FILE = "history.json"
ROSALIA_ARTIST_ID = "7ltDVBr6mKbRvohxheJ9h1"  # ROSALÍA Spotify Artist ID

def load_json(filepath, default):
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"Error loading {filepath}: {e}")
            return default
    return default

def save_json(filepath, data):
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

def get_spotify_client():
    # This matches standard headless environment behavior by using standard env variables
    return spotipy.Spotify(auth_manager=SpotifyOAuth(
        client_id=os.environ.get("SPOTIPY_CLIENT_ID"),
        client_secret=os.environ.get("SPOTIPY_CLIENT_SECRET"),
        redirect_uri=os.environ.get("SPOTIPY_REDIRECT_URI"),
        scope="user-read-recently-played",
        open_browser=False,
        cache_path=None # Disables local file caching requirement which triggers the prompt
    ))


def main():
    sp = get_spotify_client()
    
    # 1. Fetch recently played tracks
    results = sp.current_user_recently_played(limit=50)
    items = results.get("items", [])

    if not items:
        print("No recent tracks returned by Spotify.")
        sys.exit(0)

    # Filter for ROSALÍA tracks
    rosalia_tracks = []
    for item in items:
        track = item.get("track", {})
        artists = track.get("artists", [])
        if any(artist.get("id") == ROSALIA_ARTIST_ID for artist in artists):
            rosalia_tracks.append(item)

    core_data = load_json(LAST_PLAYED_FILE, {
        "current_streak": 0,
        "active_streak": None,
        "longest_streak": {"count": 0, "start_date": "", "end_date": ""},
        "peak_volume": {"count": 0, "date": ""},
        "latest_track": None,
        "last_successful_run": "",
        "last_successful_run_date": ""
    })
    
    history_data = load_json(HISTORY_FILE, {})

    today_str = datetime.utcnow().strftime("%Y-%m-%d")
    now_iso = datetime.utcnow().isoformat() + "Z"

    # Handle case where no ROSALÍA tracks are in the latest 50 plays
    if not rosalia_tracks:
        print("No ROSALÍA tracks in recent history.")
        # Update daily heartbeat run timestamp
        if core_data.get("last_successful_run_date") != today_str:
            core_data["last_successful_run"] = now_iso
            core_data["last_successful_run_date"] = today_str
            save_json(LAST_PLAYED_FILE, core_data)
            print("Heartbeat updated for today.")
        sys.exit(0)

    # 2. Extract latest ROSALÍA play details
    latest_item = rosalia_tracks[0]
    latest_track_info = latest_item["track"]
    latest_timestamp = latest_item["played_at"]

    # 3. EARLY EXIT CHECK
    # Check if we already processed this exact play
    stored_latest = core_data.get("latest_track")
    if stored_latest and stored_latest.get("timestamp") == latest_timestamp:
        print("No new ROSALÍA track detected.")
        # Update daily heartbeat timestamp if not updated today
        if core_data.get("last_successful_run_date") != today_str:
            core_data["last_successful_run"] = now_iso
            core_data["last_successful_run_date"] = today_str
            save_json(LAST_PLAYED_FILE, core_data)
            print("Heartbeat updated for today.")
        sys.exit(0)

    # 4. Process new tracks and update history counts
    # Count all unique ROSALÍA plays in the batch that occurred on their respective dates
    for item in rosalia_tracks:
        played_at_str = item["played_at"]
        play_date = played_at_str.split("T")[0]
        
        # Incremental sync count
        history_data[play_date] = history_data.get(play_date, 0) + 1

    # Update latest track info
    album = latest_track_info.get("album", {})
    images = album.get("images", [])
    album_art = images[0]["url"] if images else ""

    core_data["latest_track"] = {
        "track_name": latest_track_info.get("name"),
        "album_name": album.get("name"),
        "album_art": album_art,
        "spotify_url": latest_track_info.get("external_urls", {}).get("spotify", ""),
        "album_url": album.get("external_urls", {}).get("spotify", ""),
        "timestamp": latest_timestamp
    }

    # 5. Recalculate Peak Volume Record
    max_volume = 0
    max_date = ""
    for d, count in history_data.items():
        if count > max_volume:
            max_volume = count
            max_date = d

    core_data["peak_volume"] = {
        "count": max_volume,
        "date": max_date
    }

    # 6. Recalculate Streaks (Current, Active, Longest)
    listened_dates = sorted([d for d, c in history_data.items() if c > 0])
    
    if listened_dates:
        # Build consecutive streak segments
        streaks = []
        curr_streak = {"start_date": listened_dates[0], "end_date": listened_dates[0]}

        for i in range(1, len(listened_dates)):
            prev = datetime.strptime(listened_dates[i - 1], "%Y-%m-%d")
            curr = datetime.strptime(listened_dates[i], "%Y-%m-%d")
            
            if (curr - prev).days == 1:
                curr_streak["end_date"] = listened_dates[i]
            else:
                streaks.append(curr_streak)
                curr_streak = {"start_date": listened_dates[i], "end_date": listened_dates[i]}
        streaks.append(curr_streak)

        # Find Longest Streak
        longest = max(streaks, key=lambda s: (datetime.strptime(s["end_date"], "%Y-%m-%d") - datetime.strptime(s["start_date"], "%Y-%m-%d")).days + 1)
        longest_count = (datetime.strptime(longest["end_date"], "%Y-%m-%d") - datetime.strptime(longest["start_date"], "%Y-%m-%d")).days + 1

        core_data["longest_streak"] = {
            "count": longest_count,
            "start_date": longest["start_date"],
            "end_date": longest["end_date"]
        }

        # Determine Active Streak
        last_streak = streaks[-1]
        last_streak_end = datetime.strptime(last_streak["end_date"], "%Y-%m-%d").date()
        today_date = datetime.utcnow().date()

        # Active if last listened day was today or yesterday
        if (today_date - last_streak_end).days <= 1:
            streak_len = (datetime.strptime(last_streak["end_date"], "%Y-%m-%d") - datetime.strptime(last_streak["start_date"], "%Y-%m-%d")).days + 1
            core_data["current_streak"] = streak_len
            core_data["active_streak"] = last_streak
        else:
            core_data["current_streak"] = 0
            core_data["active_streak"] = None

    # 7. Update Heartbeat & Save Files
    core_data["last_successful_run"] = now_iso
    core_data["last_successful_run_date"] = today_str

    save_json(LAST_PLAYED_FILE, core_data)
    save_json(HISTORY_FILE, history_data)
    print(f"Updated tracker successfully. Current streak: {core_data['current_streak']}")

if __name__ == "__main__":
    main()
