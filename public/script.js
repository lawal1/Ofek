document.addEventListener('DOMContentLoaded', function() {
    const form = document.getElementById('analysisForm');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const resultsContainer = document.getElementById('resultsContainer');
    const errorMessage = document.getElementById('errorMessage');
    const queryDisplay = document.getElementById('queryDisplay');
    const summaryText = document.getElementById('summaryText');
    const rankedList = document.getElementById('rankedList');
    const topPriority = document.getElementById('topPriority');
    const checklist = document.getElementById('checklist');
    const nextActions = document.getElementById('nextActions');
    const disclaimer = document.getElementById('disclaimer');
    
    form.addEventListener('submit', async function(e) {
        e.preventDefault();
        
        // Get form values
        const userName = document.getElementById('userName').value;
        const channelName = document.getElementById('channelName').value;
        
        // Validate inputs
        if (!userName || !channelName) {
            showError('Please fill in all fields');
            return;
        }
        
        // Hide any previous errors and results
        hideError();
        resultsContainer.style.display = 'none';
        
        // Show loading indicator
        loadingIndicator.style.display = 'block';
        
        try {
            // Send request to backend
            const response = await fetch('/analyze', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ userName, channelName })
            });
            
            const data = await response.json();
            
            if (!response.ok) {
                throw new Error(data.error || 'Something went wrong');
            }
            
            // Display the results
            displayResults(data);
            
        } catch (error) {
            showError('An error occurred during analysis: ' + error.message);
        } finally {
            loadingIndicator.style.display = 'none';
        }
    });
    
    function displayResults(results) {
        // Update query display
        queryDisplay.textContent = results.query;
        
        // Update summary
        summaryText.textContent = results.analysis.summary;
        
        // Display ranked list
        rankedList.innerHTML = '';
        results.analysis.ranked_list.forEach(video => {
            let riskClass = 'low-risk';
            let badgeClass = 'badge-low';
            
            if (video.risk === 'High') {
                riskClass = 'high-risk';
                badgeClass = 'badge-high';
            } else if (video.risk === 'Medium') {
                riskClass = 'medium-risk';
                badgeClass = 'badge-medium';
            }
            
            const videoElement = document.createElement('div');
            videoElement.className = `video-item ${riskClass}`;
            videoElement.innerHTML = `
                <div class="risk-badge ${badgeClass}">${video.risk} Risk</div>
                <div class="video-title">${video.title}</div>
                <div class="channel-name">Channel: ${video.channel}</div>
                <div class="publish-date">Published: ${new Date(video.publishedAt).toLocaleDateString()}</div>
                <div class="rationale">
                    <strong>Rationale:</strong>
                    <ul>
                        ${video.rationale.map(point => `<li>${point}</li>`).join('')}
                    </ul>
                </div>
            `;
            
            rankedList.appendChild(videoElement);
        });
        
        // Display top priority
        topPriority.innerHTML = '';
        const priorityVideos = results.analysis.ranked_list.filter(video => 
            results.analysis.top_priority.includes(video.videoId)
        );
        
        priorityVideos.forEach(video => {
            const videoElement = document.createElement('div');
            videoElement.className = 'video-item high-risk';
            videoElement.innerHTML = `
                <div class="risk-badge badge-high">High Priority</div>
                <div class="video-title">${video.title}</div>
                <div class="channel-name">Channel: ${video.channel}</div>
            `;
            
            topPriority.appendChild(videoElement);
        });
        
        // Display checklist
        checklist.innerHTML = '';
        results.analysis.checklist.forEach(item => {
            const itemElement = document.createElement('div');
            itemElement.className = 'checklist-item';
            itemElement.textContent = item;
            checklist.appendChild(itemElement);
        });
        
        // Display next actions
        nextActions.innerHTML = '';
        results.analysis.next_actions.forEach(action => {
            const actionElement = document.createElement('div');
            actionElement.className = 'action-item';
            actionElement.textContent = action;
            nextActions.appendChild(actionElement);
        });
        
        // Display disclaimer
        disclaimer.textContent = results.analysis.disclaimer;
        
        // Show results container
        resultsContainer.style.display = 'block';
    }
    
    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.style.display = 'block';
    }
    
    function hideError() {
        errorMessage.style.display = 'none';
    }
});