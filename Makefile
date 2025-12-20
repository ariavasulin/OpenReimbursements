# DWS-Receipts Makefile

.PHONY: setup dev build lint

setup:
	cd dws-app && npm install --legacy-peer-deps

dev:
	cd dws-app && npm run dev

build:
	cd dws-app && npm run build

lint:
	cd dws-app && npm run lint
