package ar.com.learnharness;

import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;
import java.util.function.Function;

/** Convert HTML accept values to Android document-provider MIME filters.
 * An empty result means unrestricted selection; callers still validate files. */
final class FilePickerTypes {
    static String[] fromAcceptTypes(String[] accepted, Function<String, String> mimeForExtension) {
        Set<String> types = new LinkedHashSet<>();
        if (accepted == null) return new String[0];
        for (String group : accepted) {
            if (group == null) continue;
            for (String raw : group.split(",")) {
                String type = raw.trim().toLowerCase(Locale.ROOT);
                if (type.isEmpty()) continue;
                if (type.equals("*/*")) return new String[0];
                if (type.startsWith(".")) {
                    String extension = type.substring(type.lastIndexOf('.') + 1);
                    // Markdown mappings differ across Android releases/providers.
                    type = extension.equals("md") || extension.equals("markdown")
                        ? "text/markdown" : mimeForExtension.apply(extension);
                    // Do not silently exclude an extension the page accepts just
                    // because this Android version has no MIME registration.
                    if (type == null || type.isEmpty()) return new String[0];
                }
                if (type.contains("/")) types.add(type);
            }
        }
        if (types.contains("text/markdown") || types.contains("text/x-markdown")) {
            types.add("text/markdown"); types.add("text/x-markdown");
            types.add("text/plain"); types.add("application/octet-stream");
        }
        if (types.contains("application/zip") || types.contains("application/x-zip-compressed")) {
            types.add("application/zip"); types.add("application/x-zip-compressed");
            types.add("application/octet-stream");
        }
        return types.toArray(new String[0]);
    }
}
