package ar.com.learnharness;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

public class FilePickerTypesTest {
    private Set<String> types(String... accepted) {
        return new HashSet<>(Arrays.asList(FilePickerTypes.fromAcceptTypes(accepted, extension -> {
            switch (extension) {
                case "txt": return "text/plain";
                case "pdf": return "application/pdf";
                case "zip": return "application/zip";
                default: return null;
            }
        })));
    }
    @Test public void noteExtensionsEnableTextMarkdownAndPdf() {
        Set<String> result = types(".md,.markdown,.txt,.pdf");
        assertTrue(result.contains("text/plain"));
        assertTrue(result.contains("text/markdown"));
        assertTrue(result.contains("application/pdf"));
        assertTrue(result.contains("application/octet-stream"));
        assertFalse(result.contains("application/zip"));
    }
    @Test public void textKeyInputDoesNotBecomeAZipPicker() {
        assertEquals(Set.of("text/plain"), types(".txt", "text/plain"));
    }
    @Test public void backupExtensionRetainsProviderAliases() {
        assertEquals(Set.of("application/zip", "application/x-zip-compressed", "application/octet-stream"), types(".lhbackup.zip,application/zip"));
    }
    @Test public void nativeMimeTypesAndWildcardsArePreserved() {
        assertEquals(Set.of("image/*", "application/pdf"), types("image/*", "application/pdf"));
        assertTrue(types("image/*", "*/*").isEmpty());
    }
    @Test public void missingAcceptDoesNotRestrictSelectionToArchives() {
        assertTrue(types().isEmpty()); assertTrue(types("").isEmpty());
        assertEquals(0, FilePickerTypes.fromAcceptTypes(null, extension -> null).length);
    }
    @Test public void unknownExtensionIsNotSilentlyExcluded() {
        assertTrue(types(".pdf,.customnote").isEmpty());
    }
    @Test public void commaListsCaseAndDuplicatesAreNormalized() {
        assertEquals(Set.of("text/plain", "application/pdf"), types(" .TXT, .PDF ", "text/plain", null));
    }
}
