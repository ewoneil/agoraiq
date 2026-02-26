name: AgoraIQ Hourly Collection

on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:

jobs:
  collect:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'

      - name: Install dependencies
        run: pip install requests

      - name: Run collection
        env:
          ANTHROPIC_KEY: ${{ secrets.ANTHROPIC_KEY }}
          AIRTABLE_KEY: ${{ secrets.AIRTABLE_KEY }}
        run: python collect.py
