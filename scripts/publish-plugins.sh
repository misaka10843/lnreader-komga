#!/bin/bash

if [ -z "$GITHUB_STEP_SUMMARY" ]; then
    GITHUB_STEP_SUMMARY="/dev/stdout"
fi

current=`git rev-parse --abbrev-ref HEAD`
if [[ "$1" == "--all-branches" ]]; then
    version=$(node -e "console.log(require('./package.json').version);")
    dist="gh-pages"
    echo "Publishing plugins (all branches): $current -> $dist (v$version)"
    rm -rf .dist .js
    git fetch --all
    branches=$(git branch -r | grep -v '\->')
    for branch in $branches; do
        # Skip branches with different publish-plugins.sh version
        if ! diff scripts/publish-plugins.sh <(git show "$branch:scripts/publish-plugins.sh") >/dev/null; then
            echo "⚠️  Skipping $branch (script version mismatch)"
            continue
        fi
        echo "::group::Branch $branch"
        echo "Processing: $branch"
        git stash push -a -- .dist .js
        git checkout -f $branch
        exists=`git show-ref refs/heads/$dist`
        if [ -n "$exists" ]; then
            git branch -D $dist
        fi
        git stash pop
        npm run clean:multisrc
        npm run build:multisrc
        echo "Compiling TypeScript..."
        npx tsc --project tsconfig.production.json
        echo "# $branch" >> $GITHUB_STEP_SUMMARY
        BRANCH=$dist npm run build:manifest -- --only-new 2>> $GITHUB_STEP_SUMMARY
        if [ ! -d ".dist" ] || [ -z "$(ls -A .dist)" ]; then
            echo "❌ ERROR: Manifest generation failed - .dist is missing or empty"
            exit 1
        fi
        echo "✅ Done: $branch"
        echo "::endgroup::"
    done
    echo
    echo "::group::Publish All Branches"
    echo "Publishing combined plugins..."
    git checkout --orphan $dist
    if [ $? -eq 1 ]; then
        echo "❌ ERROR: Failed to create branch $dist"
        echo "::endgroup::"
        exit 1
    fi
    git reset
    # Copy plugins to legacy path (.js/src/plugins) for backward compatibility
    echo "Copying .js/plugins -> .js/src/plugins"
    mkdir -p .js/src
    cp -r .js/plugins .js/src/plugins
    git add -f public/static .dist .js/src/plugins total.svg
    git commit -m "chore: Publish Plugins From All Branches"
    git push -f origin $dist
    git checkout -f $branch
    echo "✅ Published all branches to $dist"
    echo "::endgroup::"
    exit 0
else
    version=${1:-$(node -e "console.log(require('./package.json').version);")}
    dist=${2:-"gh-pages"}
    echo "Publishing plugins: $current -> $dist (v$version)"
fi

exists=`git show-ref refs/heads/$dist`

if [ -n "$exists" ]; then
    git branch -D $dist
fi

git checkout --orphan $dist 2>&1

if [ $? -eq 1 ]; then
    echo "❌ ERROR: Failed to create branch $dist"
    exit 1
fi

git reset
rm -rf .js
npm run clean:multisrc
npm run build:multisrc
echo "Compiling TypeScript..."
npx tsc --project tsconfig.production.json
npm run build:manifest

if [ ! -d ".dist" ] || [ -z "$(ls -A .dist)" ]; then
    echo "❌ ERROR: Manifest generation failed - .dist is missing or empty"
    exit 1
fi

# Copy plugins to legacy path (.js/src/plugins) for backward compatibility
echo "Copying .js/plugins -> .js/src/plugins"
mkdir -p .js/src
cp -r .js/plugins .js/src/plugins
git add -f public/static .dist .js/src/plugins total.svg
git commit -m "chore: Publish Plugins"
git push -f origin $dist 2>&1
git checkout -f $current 2>&1
echo "✅ Published to $dist"

