#!/usr/bin/env python3
"""Render the assembled manuscript without loading network or local-file resources."""
import logging
import sys
from weasyprint import HTML
logging.getLogger('weasyprint').setLevel(logging.CRITICAL)

def deny_resources(url, *args, **kwargs):
    raise ValueError('External resources are disabled for manuscript exports')

if __name__ == '__main__':
    html = sys.stdin.buffer.read().decode('utf-8')
    sys.stdout.buffer.write(HTML(string=html, url_fetcher=deny_resources).write_pdf())
