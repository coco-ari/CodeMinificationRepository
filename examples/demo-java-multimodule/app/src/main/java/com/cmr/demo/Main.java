package com.cmr.demo;

import com.cmr.demo.common.HealthMessage;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;

public final class Main {
    public static void main(String[] args) throws Exception {
        int port = 18081;
        boolean unhealthy = false;
        for (String arg : args) {
            if (arg.startsWith("--port=")) port = Integer.parseInt(arg.substring(7));
            if (arg.equals("--unhealthy")) unhealthy = true;
        }
        final boolean failHealth = unhealthy;
        HttpServer server = HttpServer.create(new InetSocketAddress("0.0.0.0", port), 16);
        server.createContext("/health", exchange -> {
            byte[] body = HealthMessage.body(failHealth).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/plain; charset=utf-8");
            exchange.sendResponseHeaders(failHealth ? 503 : 200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        Runtime.getRuntime().addShutdownHook(new Thread(() -> server.stop(0)));
        server.start();
        System.out.println("多模块部署演示服务已启动，端口：" + port);
    }
}
