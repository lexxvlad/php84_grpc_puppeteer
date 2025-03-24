FROM php:8.4-apache

LABEL maintainer="Alexey Mikhaltsov <lexxvlad@gmail.com>"

# Install packages
RUN apt-get update && apt-get install -y \
    curl \
    gnupg \
    libbz2-dev \
    libcurl4-gnutls-dev \
    libfreetype6-dev \
    libjpeg62-turbo-dev \
    libpng-dev \
    libzip-dev \
    zlib1g-dev \
    libicu-dev \
    libssl-dev \
    libxslt1-dev \
    libkrb5-dev \
    unzip \
    fonts-liberation \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libnss3 \
    libxss1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libappindicator3-1 \
    libatspi2.0-0 \
    libgtk-3-0 \
    libxshmfence1

# PHP extensions
RUN docker-php-ext-configure gd --with-freetype --with-jpeg && \
    docker-php-ext-install -j$(nproc) \
    bcmath \
    bz2 \
    intl \
    gd \
    zip \
    mysqli \
    pdo_mysql \
    sockets

# gRPC + protobuf
RUN pecl install grpc && docker-php-ext-enable grpc
ADD --chmod=0755 https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions /usr/local/bin/
RUN install-php-extensions protobuf

# Install Composer
RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer && \
    chmod +x /usr/local/bin/composer

# Node.js + Puppeteer
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g npm && \
    npm install puppeteer

# Apache modules
RUN a2enmod rewrite actions

# Clear
RUN docker-php-source delete && \
    apt-get remove -y g++ gnupg curl unzip && \
    apt-get autoremove --purge -y && \
    apt-get clean -y && \
    rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

# PHP settings
ADD php.ini /usr/local/etc/php/conf.d/php.ini
