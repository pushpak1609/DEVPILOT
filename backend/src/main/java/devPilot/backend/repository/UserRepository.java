package devPilot.backend.repository;
import devPilot.backend.entity.*;
import java.util.*;
import org.springframework.data.jpa.repository.JpaRepository;


public interface UserRepository extends JpaRepository<User, UUID> {
    Optional<User> findByGithubId(Long githubId);
}
