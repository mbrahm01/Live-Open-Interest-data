# 📈 NSE Live Open Interest Visualizer

A real-time web application that fetches **live Open Interest (OI) data from the National Stock Exchange (NSE)**, visualizes it using an interactive HTML/JavaScript bar chart, and automatically refreshes every **60 seconds** to provide the latest market insights.

## Features

- 📊 Fetches live Open Interest data directly from NSE
- 📈 Interactive bar chart visualization using HTML, CSS, and JavaScript
- 🔄 Automatically refreshes every 60 seconds
- ⚡ Fast and lightweight web interface
- 🎯 Helps identify support and resistance levels through OI analysis
- 📱 Responsive design for desktop and mobile browsers

## Use Cases

- Monitor live Open Interest across strike prices
- Track changes in Call and Put OI
- Identify potential support and resistance zones
- Assist in options trading decisions
- Visualize market sentiment in real time

## Tech Stack

- Python (Backend)
- HTML5
- CSS3
- JavaScript (ES6)
- Fetch API
- NSE Open Interest Data API

## How It Works

1. Fetches the latest Open Interest data from NSE using the Python backend.
2. Processes and formats the data into JSON.
3. Sends the data to the frontend.
4. JavaScript dynamically renders an interactive bar chart.
5. The application automatically refreshes the data every **60 seconds** without requiring a page reload.

## Future Improvements

- Automatically detect the current expiry
- Multi Expiry OI filter option
- Export chart as PNG or CSV
- Introduce ML algos which are trained on historical OI data to predict the market moves
---

**A lightweight, real-time Open Interest dashboard for traders to monitor options activity and market sentiment.**