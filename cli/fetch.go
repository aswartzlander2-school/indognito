package main

// Getting the Indognito app bundle:
//   - GNITO_BUNDLE: a local bundle file
//   - running from a source checkout (gnito built in the repo): the local tree, no download
//   - GitHub release assets — anonymously when the repository is public, otherwise through the GitHub
//     API with a token (GITHUB_TOKEN / GH_TOKEN, or the GitHub CLI's login: "gh auth login")

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

var ghRelease = regexp.MustCompile(`^https://github\.com/([^/]+)/([^/]+)/releases/download/([^/]+)/([^/]+)$`)

func githubToken() string {
	for _, k := range []string{"GNITO_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"} {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	if gh, err := exec.LookPath("gh"); err == nil {
		if out, err := exec.Command(gh, "auth", "token").Output(); err == nil {
			return strings.TrimSpace(string(out))
		}
	}
	return ""
}

// openURL GETs url; a GitHub release asset of a private repository is fetched through the API with a token.
func openURL(url string) (*http.Response, error) {
	resp, err := httpClient().Get(url)
	if err == nil && resp.StatusCode == 200 {
		return resp, nil
	}
	m := ghRelease.FindStringSubmatch(url)
	tok := ""
	if m != nil {
		tok = githubToken()
	}
	if m == nil || tok == "" {
		if err != nil {
			return nil, err
		}
		resp.Body.Close()
		if m != nil && (resp.StatusCode == 404 || resp.StatusCode == 403) {
			return nil, fmt.Errorf("%s: HTTP %d — if the repository is private, sign in with \"gh auth login\" "+
				"(or set GITHUB_TOKEN) and run setup again", url, resp.StatusCode)
		}
		return nil, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	if resp != nil {
		resp.Body.Close()
	}
	owner, repo, tag, name := m[1], m[2], m[3], m[4]
	api := func(u, accept string) (*http.Response, error) {
		req, _ := http.NewRequest("GET", u, nil)
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Accept", accept)
		req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
		return httpClient().Do(req)
	}
	r, err := api(fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/tags/%s", owner, repo, tag), "application/vnd.github+json")
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub release %s of %s/%s: HTTP %d (does your token have access?)", tag, owner, repo, r.StatusCode)
	}
	var rel struct {
		Assets []struct {
			ID   int64  `json:"id"`
			Name string `json:"name"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&rel); err != nil {
		return nil, err
	}
	for _, a := range rel.Assets {
		if a.Name == name {
			ar, err := api(fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/assets/%d", owner, repo, a.ID), "application/octet-stream")
			if err != nil {
				return nil, err
			}
			if ar.StatusCode != 200 {
				ar.Body.Close()
				return nil, fmt.Errorf("%s: HTTP %d", name, ar.StatusCode)
			}
			return ar, nil
		}
	}
	return nil, fmt.Errorf("release %s has no file %s", tag, name)
}

// sourceRoot finds the repository when gnito runs from a source checkout (e.g. cli/build/gnito).
func sourceRoot() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	exe, _ = filepath.EvalSymlinks(exe)
	d := filepath.Dir(exe)
	for i := 0; i < 4 && d != filepath.Dir(d); i++ {
		if fileExists(filepath.Join(d, "server", "package.json")) && fileExists(filepath.Join(d, "web", "index.html")) && fileExists(filepath.Join(d, "VERSION")) {
			if fileExists(filepath.Join(d, "server", "node_modules", "@mercuryworkshop", "scramjet", "package.json")) {
				return d
			}
		}
		d = filepath.Dir(d)
	}
	return ""
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// bundleSource packs a source checkout into an app bundle (same layout as a release bundle).
func bundleSource(root, dest string) (string, error) {
	f, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	gz := gzip.NewWriter(io.MultiWriter(f, h))
	tw := tar.NewWriter(gz)
	top := "indognito-" + Version
	for _, part := range []string{"server", "web", "VERSION", "LICENSE", "NOTICE.md", "README.md"} {
		src := filepath.Join(root, part)
		if !fileExists(src) {
			continue
		}
		err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(root, p)
			rel = filepath.ToSlash(rel)
			if strings.HasPrefix(rel, "server/test") || strings.Contains(rel, "/.git") {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			link := ""
			if info.Mode()&os.ModeSymlink != 0 {
				link, _ = os.Readlink(p)
			}
			hdr, err := tar.FileInfoHeader(info, link)
			if err != nil {
				return err
			}
			hdr.Name = top + "/" + rel
			if d.IsDir() {
				hdr.Name += "/"
			}
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			if info.Mode().IsRegular() {
				in, err := os.Open(p)
				if err != nil {
					return err
				}
				_, err = io.Copy(tw, in)
				in.Close()
				return err
			}
			return nil
		})
		if err != nil {
			return "", err
		}
	}
	if err := tw.Close(); err != nil {
		return "", err
	}
	if err := gz.Close(); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
