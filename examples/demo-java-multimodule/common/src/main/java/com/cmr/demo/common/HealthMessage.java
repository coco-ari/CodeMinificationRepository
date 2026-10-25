package com.cmr.demo.common;

public final class HealthMessage {
    private HealthMessage() {}

    public static String body(boolean unhealthy) {
        return unhealthy ? "unhealthy" : "cmr-demo-ready";
    }
}
