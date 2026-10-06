# EdgeLink

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Assumption for this build: plain HTML/CSS/JavaScript, Manifest V3, a Windows .NET Framework native messaging host, and an official Mihomo executable. No frontend build step is required to load the extension.

## Users

The user works on Windows and wants to manage Edge proxy connections from a browser extension.

## Product Purpose

An Edge extension with 首页、代理、订阅、连接、规则、日志、测试、设置. Import a configuration from a URL, connect through its nodes, and detect the actual public IP and region after connection.

## Operating Context

Windows desktop, Microsoft Edge. The user explicitly chose an independent local core, without requiring Clash Verge. Browser proxy settings apply to the regular Edge profile; the Windows system proxy remains outside this product's scope.

## Capabilities and Constraints

Mihomo executes encrypted proxy protocols locally. Native messaging manages the core. The extension owns Edge proxy configuration only while enabled. URL subscriptions and credentials are local data. Exit location comes from external IP geolocation services and is an approximate network location. A private subscription was supplied for functional testing; its URL, response and node credentials must stay out of source, reports and packages.

## Brand Commitments

The attached reference fixes a dark sidebar with blue selected navigation and the eight Chinese navigation names. EdgeLink is a provisional product name, chosen for this build.

## Evidence on Hand

User-provided sidebar screenshot. Functional verification must distinguish a local test proxy from a real remote VPN node.

## Product Principles

Show actual state and measured results. Preserve personal system settings. Keep subscriptions on this computer. Provide a usable local installation package.
