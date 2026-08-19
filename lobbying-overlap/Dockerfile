# Apify Python base image, Python 3.11.
FROM apify/actor-python:3.11

COPY requirements.txt ./

RUN echo "Python version:" \
    && python --version \
    && echo "Installing dependencies:" \
    && pip install --no-cache-dir -r requirements.txt \
    && echo "All installed dependencies:" \
    && pip freeze

COPY . ./

CMD ["python", "-m", "src"]
