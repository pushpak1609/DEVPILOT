package devPilot.backend.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record RenameSessionRequest(
        @NotBlank @Size(max = 200) String title
) {}
