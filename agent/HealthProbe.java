import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** 在业务容器内部检查 HTTP 就绪状态，兼容 Java 8。 */
public final class HealthProbe {
    public static void main(String[] args) {
        HttpURLConnection connection = null;
        try {
            URL url = new URL("http://127.0.0.1:" + Integer.parseInt(args[0]) + args[1]);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(2000);
            connection.setReadTimeout(3000);
            connection.setInstanceFollowRedirects(false);
            if (connection.getResponseCode() != Integer.parseInt(args[2])) System.exit(1);
            if (args.length > 3 && !args[3].isEmpty()) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                try (InputStream input = connection.getInputStream()) {
                    byte[] buffer = new byte[4096];
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        output.write(buffer, 0, count);
                        if (output.size() > 1048576) System.exit(1);
                    }
                }
                if (!new String(output.toByteArray(), StandardCharsets.UTF_8).contains(args[3])) System.exit(1);
            }
        } catch (Exception failure) {
            System.exit(1);
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}
